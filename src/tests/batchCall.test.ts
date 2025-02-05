import { expect, test, describe, mock } from "bun:test";
import { workerBatcher, BatchProcessingError } from '../index';

describe('workerBatcher', () => {
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
        const items = Array.from({ length: 100 }, (_, i) => i); // Больше элементов
        const controller = new AbortController();
        const processor = mock(async (batch: number[]) => {
            await new Promise(resolve => setTimeout(resolve, 50)); // Увеличим задержку
            return batch;
        });

        // Запускаем обработку
        const promise = workerBatcher(items, processor, {
            batchSize: 2,
            concurrency: 2,
            signal: controller.signal
        });

        // Даем немного времени для начала обработки
        await new Promise(resolve => setTimeout(resolve, 10));
        
        // Отменяем операцию
        controller.abort();

        // Проверяем, что промис был отклонен с правильной ошибкой
        await expect(promise).rejects.toThrow('Operation was aborted');
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
});
