const isEmptyArray = (array: unknown[]) => array.length === 0;

interface BatchOptions<T, R> {
  batchSize?: number;
  concurrency?: number;
  onBatchSuccess?: (results: R[], batch: T[], batchIndex: number) => void;
  onBatchError?: (error: Error, batch: T[], batchIndex: number) => void;
  onProgress?: (progress: {
    completed: number;
    total: number;
    percent: number;
  }) => void;
  signal?: AbortSignal;
}

export class BatchProcessingError extends Error {
  constructor(
    message: string,
    public readonly batch: unknown[],
    public readonly batchIndex: number,
    public readonly originalError: Error
  ) {
    super(message);
    this.name = 'BatchProcessingError';
  }
}

/**
 * Processes an array in batches with controlled concurrency using a worker pool pattern.
 *
 * @param items Array of items to process
 * @param processor Async callback function to process each batch of items
 * @param options Configuration options for batch processing
 * @returns Promise that resolves with processed results and any errors
 */
export async function workerBatcher<T, R>(
  items: T[],
  processor: (batch: T[]) => Promise<R[]>,
  options: BatchOptions<T, R> = {}
): Promise<{ results: R[]; errors: BatchProcessingError[] }> {
  const {
    batchSize = 10,
    concurrency = 5,
    onBatchSuccess,
    onBatchError,
    onProgress,
    signal
  } = options;

  if (isEmptyArray(items) || !Array.isArray(items)) {
    return { results: [], errors: [] };
  }

  if (signal?.aborted) {
    throw new Error('Operation was aborted');
  }

  const results: R[] = [];
  const errors: BatchProcessingError[] = [];
  const batches: T[][] = [];

  // Split items into batches
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  let currentBatchIndex = 0;
  let completedBatches = 0;
  const activeWorkers = new Set<Promise<void>>();

  const updateProgress = () => {
    if (onProgress) {
      const completed = completedBatches;
      const total = batches.length;
      const percent = Math.round((completed / total) * 100);
      onProgress({ completed, total, percent });
    }
  };

  // Process all batches maintaining constant number of active workers
  while (currentBatchIndex < batches.length || activeWorkers.size > 0) {
    if (signal?.aborted) {
      throw new Error('Operation was aborted');
    }

    // Fill the worker pool up to the concurrency limit
    while (activeWorkers.size < concurrency && currentBatchIndex < batches.length) {
      const batchIndex = currentBatchIndex++;
      const currentBatch = batches[batchIndex];

      const worker = (async () => {
        try {
          const batchResults = await processor(currentBatch);
          results.push(...batchResults);
          completedBatches++;
          updateProgress();
          onBatchSuccess?.(batchResults, currentBatch, batchIndex);
        } catch (error) {
          const batchError = new BatchProcessingError(
            `Failed to process batch ${batchIndex}`,
            currentBatch,
            batchIndex,
            error instanceof Error ? error : new Error(String(error))
          );
          errors.push(batchError);
          onBatchError?.(batchError, currentBatch, batchIndex);
        }
      })();

      activeWorkers.add(worker);
      // Clean up completed worker
      void worker.then(() => {
        activeWorkers.delete(worker);
      });
    }

    // Wait for at least one worker to complete before next iteration
    if (activeWorkers.size > 0) {
      await Promise.race(activeWorkers);
    }
  }

  return { results, errors };
}

export default workerBatcher;
