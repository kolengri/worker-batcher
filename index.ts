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

/**
 * Error class for batch processing failures
 * Contains additional context about the failed batch
 * 
 * @property batch - The batch of items that failed to process
 * @property batchIndex - Index of the failed batch
 * @property originalError - The original error that caused the failure
 */
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
 * Processes an array of items in batches with controlled concurrency using a worker pool pattern.
 * 
 * How it works:
 * 1. Input array is split into smaller batches of specified size
 * 2. Creates a pool of workers up to the concurrency limit
 * 3. Each worker processes one batch at a time asynchronously
 * 4. When a worker finishes, it takes the next batch from the queue
 * 5. Maintains a constant number of active workers throughout processing
 * 6. Collects results from all successful batches into a single array
 * 7. Collects any errors that occur during processing
 * 8. Reports progress and batch status through callbacks
 * 
 * @example
 * ```typescript
 * const items = [1, 2, 3, 4, 5, 6];
 * const { results, errors } = await workerBatcher(
 *   items,
 *   async (batch) => {
 *     return batch.map(x => x * 2);
 *   },
 *   {
 *     batchSize: 2,
 *     concurrency: 3,
 *     onProgress: ({ percent }) => console.log(`Progress: ${percent}%`)
 *   }
 * );
 * ```
 * 
 * @param items - Array of items to process
 * @param processor - Async function that processes each batch of items
 *                   Takes an array of items and returns a promise of processed results
 * @param options - Configuration options for batch processing
 * 
 * @param options.batchSize - Number of items to process in one batch (default: 10)
 * @param options.concurrency - Maximum number of concurrent batch operations (default: 5)
 * @param options.signal - AbortSignal for cancelling the operation
 * @param options.onBatchSuccess - Callback function called after each successful batch
 *                                Receives: processed results, original batch items, and batch index
 * @param options.onBatchError - Callback function called when a batch fails
 *                              Receives: error object, failed batch items, and batch index
 * @param options.onProgress - Callback function for tracking overall progress
 *                            Receives: { completed, total, percent }
 * 
 * @returns Promise resolving to an object containing:
 *          - results: Array of all successfully processed items
 *          - errors: Array of BatchProcessingError objects for failed batches
 * 
 * @throws Error if the operation is aborted via AbortSignal
 * @throws BatchProcessingError for individual batch failures (collected in errors array)
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
