type BatchOptions<T, R> = {
  batchSize?: number;
  concurrency?: number;
  onBatchSuccess?: (results: R[], batch: T[], batchIndex: number) => void;
  onBatchError?: (error: Error, batch: T[], batchIndex: number) => void;
  onProgress?: (progress: { completed: number; total: number; percent: number }) => void;
  signal?: AbortSignal;
};

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
 * Error class specifically for abort operations
 * Extends BatchProcessingError to maintain consistent error handling
 */
export class BatchAbortError extends BatchProcessingError {
  constructor(batch: unknown[], batchIndex: number) {
    super('Operation was aborted', batch, batchIndex, new Error('AbortError'));
    this.name = 'BatchAbortError';
  }
}

/**
 * Handles batch processing logic and worker pool management
 */
class BatchProcessor<T, R> {
  private readonly results: R[] = [];
  private readonly errors: BatchProcessingError[] = [];
  private completedBatches = 0;
  private readonly activeWorkers = new Set<Promise<void>>();

  constructor(
    private readonly batches: T[][],
    private readonly processor: (batch: T[]) => Promise<R[]>,
    private readonly options: BatchOptions<T, R>
  ) {}

  private updateProgress(): void {
    const { onProgress } = this.options;
    if (onProgress) {
      const completed = this.completedBatches;
      const total = this.batches.length;
      const percent = Math.round((completed / total) * 100);
      onProgress({ completed, total, percent });
    }
  }

  private checkAbort(batchIndex: number): void {
    const { signal } = this.options;
    if (signal?.aborted) {
      const remainingItems = this.batches.slice(batchIndex).flat();
      const abortError = new BatchAbortError(remainingItems, batchIndex);
      throw abortError;
    }
  }

  private async processBatch(batch: T[], batchIndex: number): Promise<void> {
    const { onBatchSuccess } = this.options;

    try {
      this.checkAbort(batchIndex);
      const batchResults = await this.processor(batch);
      this.checkAbort(batchIndex);

      this.results.push(...batchResults);
      this.completedBatches++;
      this.updateProgress();
      onBatchSuccess?.(batchResults, batch, batchIndex);
    } catch (error) {
      this.handleBatchError(error, batch, batchIndex);
    }
  }

  private handleBatchError(error: unknown, batch: T[], batchIndex: number): void {
    const { onBatchError } = this.options;

    if (error instanceof BatchAbortError) {
      if (!this.errors.some((e) => e instanceof BatchAbortError)) {
        this.errors.push(error);
        onBatchError?.(error, batch, batchIndex);
      }
      return;
    }

    const batchError = new BatchProcessingError(
      `Failed to process batch ${batchIndex}`,
      batch,
      batchIndex,
      error instanceof Error ? error : new Error(String(error))
    );

    this.errors.push(batchError);
    onBatchError?.(batchError, batch, batchIndex);
  }

  public async process(): Promise<{ results: R[]; errors: BatchProcessingError[] }> {
    const { concurrency = 5 } = this.options;

    let currentBatchIndex = 0;
    try {
      while (currentBatchIndex < this.batches.length || this.activeWorkers.size > 0) {
        this.checkAbort(currentBatchIndex);

        // Fill worker pool up to concurrency limit
        while (this.activeWorkers.size < concurrency && currentBatchIndex < this.batches.length) {
          const batchIndex = currentBatchIndex++;

          const worker = this.processBatch(this.batches[batchIndex], batchIndex);

          this.activeWorkers.add(worker);

          void worker.then(() => {
            this.activeWorkers.delete(worker);
          });
        }

        // Wait for at least one worker to complete
        if (this.activeWorkers.size > 0) {
          await Promise.race(this.activeWorkers);
        }

        this.checkAbort(currentBatchIndex);
      }
    } catch (error) {
      this.handleBatchError(error, this.batches[currentBatchIndex], currentBatchIndex);
    }

    return { results: this.results, errors: this.errors };
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
 * 9. In case of abort signal, allows current batches to complete and returns partial results
 *
 * @example
 * ```typescript
 * const controller = new AbortController();
 *
 * const items = [1, 2, 3, 4, 5, 6];
 * const { results, errors } = await workerBatcher(
 *   items,
 *   async (batch) => {
 *     return batch.map(x => x * 2);
 *   },
 *   {
 *     batchSize: 2,
 *     concurrency: 3,
 *     signal: controller.signal,
 *     onProgress: ({ percent }) => console.log(`Progress: ${percent}%`)
 *   }
 * );
 *
 * // Abort processing after some condition
 * controller.abort();
 * // Function will return partial results and include BatchAbortError in errors array
 * ```
 *
 * @param items - Array of items to process
 * @param processor - Async function that processes each batch of items
 *                   Takes an array of items and returns a promise of processed results
 * @param options - Configuration options for batch processing
 *
 * @param options.batchSize - Number of items to process in one batch (default: 10)
 * @param options.concurrency - Maximum number of concurrent batch operations (default: 5)
 * @param options.signal - AbortSignal for gracefully stopping new batch processing
 *                        When aborted, current batches will complete and function will
 *                        return partial results with BatchAbortError for remaining items
 * @param options.onBatchSuccess - Callback function called after each successful batch
 *                                Receives: processed results, original batch items, and batch index
 * @param options.onBatchError - Callback function called when a batch fails
 *                              Receives: error object, failed batch items, and batch index
 * @param options.onProgress - Callback function for tracking overall progress
 *                            Receives: { completed, total, percent }
 *
 * @returns Promise resolving to an object containing:
 *          - results: Array of all successfully processed items (including partial results if aborted)
 *          - errors: Array of BatchProcessingError objects for failed batches and remaining items if aborted
 *
 * @throws BatchProcessingError for individual batch failures (collected in errors array)
 * @note When aborted via signal, a BatchAbortError will be added to the errors array for remaining unprocessed items,
 *       but the function will still return with partial results from completed batches
 */
export async function workerBatcher<T, R>(
  items: T[],
  processor: (batch: T[]) => Promise<R[]>,
  options: BatchOptions<T, R> = {}
): Promise<{ results: R[]; errors: BatchProcessingError[] }> {
  const { batchSize = 10 } = options;

  if (!Array.isArray(items) || items.length === 0) {
    return { results: [], errors: [] };
  }

  // Split items into batches
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }

  const batchProcessor = new BatchProcessor(batches, processor, options);
  return await batchProcessor.process();
}

export default workerBatcher;
