import { expect, test, describe, mock } from "bun:test";
import { workerBatcher, BatchProcessingError, BatchAbortError } from '../index';

describe(workerBatcher.name, () => {
    // Helper function to create a delayed processor
    const createDelayedProcessor = (delay: number) =>
        async (items: number[]): Promise<number[]> => {
            await new Promise(resolve => setTimeout(resolve, delay));
            return items.map(item => item * 2);
        };

    test('should process all items correctly', async () => {
        const items = [1, 2, 3, 4, 5];
        const processor = mock(async (batch: number[]) => batch.map(x => x * 2));

        const { results, errors } = await workerBatcher(items, processor, {
            batchSize: 2
        });

        expect(results).toEqual([2, 4, 6, 8, 10]);
        expect(errors).toEqual([]);
        expect(processor).toHaveBeenCalledTimes(3); // Called with [1,2], [3,4], and [5]
    });

    test('should respect batch size', async () => {
        const items = [1, 2, 3, 4, 5, 6];
        const processor = mock(async (batch: number[]) => batch);
        const batchSize = 2;

        const { results, errors } = await workerBatcher(items, processor, {
            batchSize,
            concurrency: 1
        });

        expect(results).toEqual(items);
        expect(errors).toEqual([]);
        expect(processor).toHaveBeenCalledTimes(3); // Called with [1,2], [3,4], and [5,6]
    });

    test('should handle empty array', async () => {
        const items: number[] = [];
        const processor = mock(async (batch: number[]) => batch);

        const { results, errors } = await workerBatcher(items, processor);

        expect(results).toEqual([]);
        expect(errors).toEqual([]);
        expect(processor).toHaveBeenCalledTimes(0);
    });

    test('should collect errors while continuing processing', async () => {
        const items = [1, 2, 3, 4, 5, 6];
        const expectedError = new Error('Test error');
        const processor = mock(async (batch: number[]) => {
            if (batch.includes(2) || batch.includes(5)) throw expectedError;
            return batch;
        });

        const { results, errors } = await workerBatcher(items, processor, {
            batchSize: 2
        });

        expect(results).toEqual([3, 4]);
        expect(errors).toHaveLength(2);
        expect(errors[0]).toBeInstanceOf(BatchProcessingError);
        expect(errors[0].originalError).toEqual(expectedError);
    });

    test('should respect concurrency limit', async () => {
        const items = [1, 2, 3, 4, 5, 6];
        let currentConcurrent = 0;
        let maxConcurrent = 0;

        const processor = mock(async (batch: number[]) => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
            await new Promise(resolve => setTimeout(resolve, 10));
            currentConcurrent--;
            return batch;
        });

        const { results, errors } = await workerBatcher(items, processor, {
            batchSize: 2,
            concurrency: 2
        });

        expect(results).toEqual(items);
        expect(errors).toEqual([]);
        expect(maxConcurrent).toBeLessThanOrEqual(2);
        expect(processor).toHaveBeenCalledTimes(3);
    });

    test('should process different data types', async () => {
        const items = ['a', 'b', 'c'];
        const processor = mock(async (batch: string[]) => batch.map(x => x.toUpperCase()));

        const { results, errors } = await workerBatcher(items, processor);

        expect(results).toEqual(['A', 'B', 'C']);
        expect(errors).toEqual([]);
    });

    test('should handle delayed processing correctly', async () => {
        const items = [1, 2, 3];
        const processor = createDelayedProcessor(10);
        
        const { results, errors } = await workerBatcher(items, processor, {
            batchSize: 2
        });

        expect(results).toEqual([2, 4, 6]);
        expect(errors).toEqual([]);
    });

    test('should maintain constant number of concurrent promises', async () => {
        const items = Array.from({ length: 10 }, (_, i) => i + 1);
        const concurrencyLimit = 3;
        const batchSize = 2;

        let currentConcurrent = 0;
        let maxConcurrent = 0;

        const processor = mock(async (batch: number[]) => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
            await new Promise(resolve => setTimeout(resolve, 10));
            currentConcurrent--;
            return batch;
        });

        const { results, errors } = await workerBatcher(items, processor, {
            batchSize,
            concurrency: concurrencyLimit
        });

        expect(results).toEqual(items);
        expect(errors).toEqual([]);
        expect(maxConcurrent).toBe(concurrencyLimit);
        expect(processor).toHaveBeenCalledTimes(Math.ceil(items.length / batchSize));
    });

    test('should call onProgress with correct progress', async () => {
        const items = [1, 2, 3, 4, 5, 6];
        const progressUpdates: Array<{ completed: number; total: number; percent: number }> = [];

        const { results } = await workerBatcher(items, 
            async (batch) => batch,
            {
                batchSize: 2,
                onProgress: (progress) => {
                    progressUpdates.push(progress);
                }
            }
        );

        expect(results).toEqual(items);
        expect(progressUpdates).toHaveLength(3); // 3 batches
        expect(progressUpdates[0]).toEqual({ completed: 1, total: 3, percent: 33 });
        expect(progressUpdates[2]).toEqual({ completed: 3, total: 3, percent: 100 });
    });

    test('should abort processing when signal is aborted', async () => {
        const items = Array.from({ length: 100 }, (_, i) => i); 
        const controller = new AbortController();
        const completedBatches: number[] = [];
        
        const processor = mock(async (batch: number[]) => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return batch;
        });

        const promise = workerBatcher(items, processor, {
            batchSize: 2,
            concurrency: 2,
            signal: controller.signal,
            onBatchSuccess: (_, __, index) => {
                completedBatches.push(index);
            }
        });

        // Allow time for processing to start
        await new Promise(resolve => setTimeout(resolve, 75));
        
        controller.abort();

        // Wait for current batches to complete
        const { results, errors } = await promise;

        // Check for BatchAbortError in errors
        expect(errors.some(error => error instanceof BatchAbortError)).toBe(true);
        
        // Verify not all items were processed after abort
        expect(results.length).toBeLessThan(items.length);
        
        // Verify some batches completed but not all
        expect(completedBatches.length).toBeGreaterThan(0);
        const totalBatches = Math.ceil(items.length / 2); // batchSize = 2
        expect(completedBatches.length).toBeLessThan(totalBatches);
    });

    test('should call onBatchSuccess with correct parameters', async () => {
        const items = [1, 2, 3, 4];
        const batchSuccesses: Array<{ results: number[], batch: number[], index: number }> = [];

        await workerBatcher(items, 
            async (batch) => batch.map(x => x * 2),
            {
                batchSize: 2,
                onBatchSuccess: (results, batch, index) => {
                    batchSuccesses.push({ results, batch, index });
                }
            }
        );

        expect(batchSuccesses).toHaveLength(2);
        expect(batchSuccesses[0]).toEqual({
            results: [2, 4],
            batch: [1, 2],
            index: 0
        });
        expect(batchSuccesses[1]).toEqual({
            results: [6, 8],
            batch: [3, 4],
            index: 1
        });
    });

    test('should call onBatchError with correct parameters', async () => {
        const items = [1, 2, 3, 4];
        const batchErrors: Array<{ error: Error, batch: number[], index: number }> = [];

        await workerBatcher(items, 
            async (batch) => {
                if (batch.includes(3)) throw new Error('Test error');
                return batch;
            },
            {
                batchSize: 2,
                onBatchError: (error, batch, index) => {
                    batchErrors.push({ error, batch, index });
                }
            }
        );

        expect(batchErrors).toHaveLength(1);
        expect(batchErrors[0].batch).toEqual([3, 4]);
        expect(batchErrors[0].index).toBe(1);
        expect(batchErrors[0].error).toBeInstanceOf(BatchProcessingError);
    });

    test('should handle abort before start', async () => {
        const controller = new AbortController();
        controller.abort();
        
        const items = [1, 2, 3, 4, 5];
        const processor = mock(async (batch: number[]) => batch);
        
        const { results, errors } = await workerBatcher(items, processor, { 
            signal: controller.signal 
        });

        expect(results).toEqual([]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(BatchAbortError);
        expect(errors[0].batch).toEqual(items);
        expect(errors[0].batchIndex).toBe(0);
        expect(processor).not.toHaveBeenCalled();
    });

    test('should handle abort during processing', async () => {
        const controller = new AbortController();
        const items = Array.from({ length: 50 }, (_, i) => i);
        const completedBatches: number[] = [];
        
        const processor = async (batch: number[]) => {
            await new Promise(resolve => setTimeout(resolve, 100));
            return batch;
        };
        
        const processingPromise = workerBatcher(items, processor, {
            batchSize: 5,
            concurrency: 2,
            signal: controller.signal,
            onBatchSuccess: (_, batch, index) => {
                completedBatches.push(index);
            }
        });
        
        // Abort after small delay to ensure processing has started
        setTimeout(() => controller.abort(), 150);
        
        const { results, errors } = await processingPromise;
        
        // Verify we have some results
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThan(items.length);
        
        // Verify we have BatchAbortError
        expect(errors.some(error => error instanceof BatchAbortError)).toBe(true);
        
        // Verify some batches completed
        expect(completedBatches.length).toBeGreaterThan(0);
        expect(Math.max(...completedBatches)).toBeLessThan(items.length / 5);
    });

    test('properly cleanup resources when aborted', async () => {
        const controller = new AbortController();
        const items = Array.from({ length: 100 }, (_, i) => i);
        const completedBatches: number[] = [];
        
        const processor = async (batch: number[]) => {
            await new Promise(resolve => setTimeout(resolve, 50));
            return batch;
        };
        
        const processingPromise = workerBatcher(items, processor, {
            batchSize: 10,
            concurrency: 3,
            signal: controller.signal,
            onBatchSuccess: (_, __, batchIndex) => {
                completedBatches.push(batchIndex);
            }
        });
        
        setTimeout(() => controller.abort(), 100);
        
        const { errors } = await processingPromise;
        
        // Check for BatchAbortError
        expect(errors.some(error => error instanceof BatchAbortError)).toBe(true);
        
        // Wait to ensure no new batches are processed
        await new Promise(resolve => setTimeout(resolve, 200));
        
        const maxCompletedBatch = Math.max(...completedBatches);
        expect(maxCompletedBatch).toBeLessThan(items.length / 10);
    });

    test('processes items in batches', async () => {
        const items = [1, 2, 3, 4, 5, 6];
        const { results, errors } = await workerBatcher(
            items,
            async (batch) => batch.map(x => x * 2),
            { batchSize: 2 }
        );

        expect(results).toEqual([2, 4, 6, 8, 10, 12]);
        expect(errors).toHaveLength(0);
    });

    test('handles empty array', async () => {
        const { results, errors } = await workerBatcher(
            [],
            async (batch) => batch,
        );

        expect(results).toEqual([]);
        expect(errors).toHaveLength(0);
    });

    test('respects batch size', async () => {
        const processor = mock(async (batch) => batch);
        
        await workerBatcher([1, 2, 3, 4, 5], processor, { batchSize: 2 });
        
        expect(processor).toHaveBeenCalledTimes(3);
        expect(processor).toHaveBeenNthCalledWith(1, [1, 2]);
        expect(processor).toHaveBeenNthCalledWith(2, [3, 4]);
        expect(processor).toHaveBeenNthCalledWith(3, [5]);
    });

    test('handles batch processing errors', async () => {
        const onBatchError = mock(() => {});
        const error = new Error('Test error');
        
        const { results, errors } = await workerBatcher(
            [1, 2, 3, 4],
            async (batch) => {
                if (batch.includes(3)) throw error;
                return batch.map(x => x * 2);
            },
            {
                batchSize: 2,
                onBatchError,
            }
        );

        expect(results).toEqual([2, 4]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(BatchProcessingError);
        expect(errors[0].originalError).toBe(error);
        expect(onBatchError).toHaveBeenCalledWith(errors[0], [3, 4], 1);
    });

    test('reports progress', async () => {
        const onProgress = mock(() => {});
        
        await workerBatcher(
            [1, 2, 3, 4],
            async (batch) => batch.map(x => x * 2),
            {
                batchSize: 2,
                onProgress,
            }
        );

        expect(onProgress).toHaveBeenCalledTimes(2);
        expect(onProgress).toHaveBeenNthCalledWith(1, { completed: 1, total: 2, percent: 50 });
        expect(onProgress).toHaveBeenNthCalledWith(2, { completed: 2, total: 2, percent: 100 });
    });

    test('handles abort signal - returns partial results', async () => {
        const controller = new AbortController();
        const onBatchSuccess = mock(() => {});
        const onBatchError = mock(() => {});
        
        const processor = async (batch: number[]) => {
            await new Promise(resolve => setTimeout(resolve, 100));
            return batch.map(x => x * 2);
        };

        const batcherPromise = workerBatcher(
            [1, 2, 3, 4, 5, 6],
            processor,
            {
                batchSize: 2,
                concurrency: 2,
                signal: controller.signal,
                onBatchSuccess,
                onBatchError,
            }
        );

        // Allow first batch to start processing
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Abort while first batch is processing
        controller.abort();
        
        // Wait for current batches to complete
        const { results, errors } = await batcherPromise;

        // Should have results from completed batches
        expect(results).toEqual([2, 4]);
        
        // Should have BatchAbortError for remaining items
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(BatchAbortError);
        expect(errors[0].batch).toEqual([5, 6]);
        expect(errors[0].batchIndex).toBe(2);
        
        // Verify callbacks were called correctly
        expect(onBatchSuccess).toHaveBeenCalledWith([2, 4], [1, 2], 0);
        expect(onBatchError).toHaveBeenCalledWith(errors[0], [5, 6], 2);
    });

    test('respects concurrency limit', async () => {
        const activeProcessors = new Set<number>();
        let maxConcurrent = 0;
        
        await workerBatcher(
            [1, 2, 3, 4, 5, 6],
            async (batch) => {
                const id = Math.random();
                activeProcessors.add(id);
                maxConcurrent = Math.max(maxConcurrent, activeProcessors.size);
                await new Promise(resolve => setTimeout(resolve, 10));
                activeProcessors.delete(id);
                return batch.map(x => x * 2);
            },
            {
                batchSize: 1,
                concurrency: 2
            }
        );

        expect(maxConcurrent).toBe(2);
    });
});
