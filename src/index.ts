/**
 * @fileoverview
 * This module provides a powerful utility for processing large arrays of data in batches with concurrent execution.
 * It is particularly useful when dealing with API calls, data transformations, or any other async operations
 * that need to be performed on large datasets while maintaining control over system resources.
 *
 * Key Use Cases:
 * - Processing large datasets without overwhelming system resources
 * - Making concurrent API calls with rate limiting
 * - Handling long-running data transformations with progress tracking
 * - Processing data with error handling and recovery options
 *
 * Benefits:
 * 1. Resource Management:
 *    - Controls memory usage by processing data in smaller chunks
 *    - Prevents system overload by limiting concurrent operations
 *
 * 2. Error Handling:
 *    - Graceful error handling for individual batches
 *    - Option to continue processing despite errors
 *    - Detailed error reporting with batch context
 *
 * 3. Progress Monitoring:
 *    - Real-time progress tracking
 *    - Batch-level success/failure callbacks
 *    - Support for operation cancellation
 *
 * 4. Flexibility:
 *    - Configurable batch sizes
 *    - Adjustable concurrency levels
 *    - TypeScript support for type safety
 *
 * Common Usage Patterns:
 * 1. API Batch Processing:
 *    - Uploading large datasets to an API
 *    - Batch downloading of resources
 *    - Rate-limited API operations
 *
 * 2. Data Processing:
 *    - Large-scale data transformations
 *    - Parallel processing of independent data chunks
 *    - ETL operations with progress tracking
 *
 * 3. Resource Management:
 *    - Controlled loading of large datasets
 *    - Memory-efficient processing of big data
 *    - Background processing with cancellation support
 *
 * @example
 * ```typescript
 * // Example: Uploading user data to an API
 * const users = ["user1", "user2", "user3", "user4", "user5"];
 *
 * const result = await workerBatcher(
 *   users,
 *   async (userBatch) => {
 *     const responses = await Promise.all(
 *       userBatch.map(user => api.uploadUser(user))
 *     );
 *     return responses;
 *   },
 *   {
 *     batchSize: 50,        // Process 50 users at a time
 *     concurrency: 3,       // Run 3 batches concurrently
 *     stopOnError: false,   // Continue on errors
 *     onProgress: ({ percent }) => {
 *       updateProgressBar(percent);
 *     }
 *   }
 * );
 * ```
 */

/**
 * Configuration options for batch processing.
 * @template T The type of items to be processed
 * @template R The type of results returned after processing
 * @property {number} [batchSize=10] - The number of items to process in each batch. Controls memory usage and processing granularity.
 * @property {number} [concurrency=5] - The maximum number of concurrent batch operations. Higher values increase throughput but also resource usage.
 * @property {boolean} [stopOnError=false] - If true, stops all processing when any batch fails. If false, continues processing other batches.
 * @property {function} [onBatchSuccess] - Callback executed after each successful batch. Receives processed results, original batch items, and batch index.
 *                                        Useful for real-time updates and progress tracking.
 * @property {function} [onBatchError] - Callback executed when a batch fails. Receives error details, failed batch items, and batch index.
 *                                      Enables custom error handling and logging.
 * @property {function} [onProgress] - Callback for tracking overall progress. Receives object with completed count, total count, and percentage.
 *                                    Perfect for updating UI progress indicators.
 * @property {AbortSignal} [signal] - Standard AbortSignal for cancelling the entire operation. When aborted, gracefully stops processing
 *                                   and returns partial results.
 */
type BatchOptions<T, R> = {
  /** The number of items to process in each batch. Default is 10. */
  batchSize?: number;
  /** The maximum number of concurrent batch operations. Default is 5. */
  concurrency?: number;
  /** Whether to stop processing when an error occurs. Default is false. */
  stopOnError?: boolean;
  /** Callback function called after each successful batch processing. */
  onBatchSuccess?: (results: R[], batch: T[], batchIndex: number) => void;
  /** Callback function called when a batch processing fails. */
  onBatchError?: (error: Error, batch: T[], batchIndex: number) => void;
  /** Callback function for tracking progress of batch processing. */
  onProgress?: (progress: { completed: number; total: number; percent: number }) => void;
  /** AbortSignal for cancelling the batch processing. */
  signal?: AbortSignal;
};

/**
 * Error thrown when a batch processing operation fails.
 * Contains information about the failed batch and the original error.
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
 * Error thrown when batch processing is aborted via AbortSignal.
 * Contains information about the batch that was being processed when abortion occurred.
 */
export class BatchAbortError extends BatchProcessingError {
  constructor(batch: unknown[], batchIndex: number) {
    super('Operation was aborted', batch, batchIndex, new Error('AbortError'));
    this.name = 'BatchAbortError';
  }
}

/**
 * Internal class that handles the batch processing logic.
 * @template T The type of items to be processed
 * @template R The type of results returned after processing
 */
class BatchProcessor<T, R> {
  private readonly results: R[] = [];
  private readonly errors: BatchProcessingError[] = [];
  private completedBatches = 0;
  private readonly activeWorkersPromises = new Set<Promise<void>>();
  private aborted = false;

  constructor(
    private readonly batches: T[][],
    private readonly processor: (batch: T[]) => Promise<R[]>,
    private readonly options: BatchOptions<T, R>
  ) {}

  /**
   * Updates the progress of batch processing and calls the onProgress callback if provided.
   */
  private updateProgress(): void {
    const { onProgress } = this.options;
    if (onProgress) {
      const completed = this.completedBatches;
      const total = this.batches.length;
      const percent = Math.round((completed / total) * 100);
      onProgress({ completed, total, percent });
    }
  }

  /**
   * Checks if the operation has been aborted via AbortSignal.
   * @param batchIndex - The index of the current batch being processed
   * @throws {BatchAbortError} If the operation has been aborted
   */
  private checkAbort(batchIndex: number): void {
    const { signal } = this.options;
    if (signal?.aborted) {
      const remainingItems = this.batches.slice(batchIndex).flat();
      throw new BatchAbortError(remainingItems, batchIndex);
    }
  }

  /**
   * Processes a single batch of items.
   * @param batch - The batch of items to process
   * @param batchIndex - The index of the current batch
   */
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

  /**
   * Handles errors that occur during batch processing.
   * @param error - The error that occurred
   * @param batch - The batch that caused the error
   * @param batchIndex - The index of the failed batch
   */
  private handleBatchError(error: unknown, batch: T[], batchIndex: number): void {
    const { onBatchError, stopOnError } = this.options;

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

    if (stopOnError) {
      this.aborted = true;
    }
  }

  /**
   * Creates and manages a worker for processing a batch.
   * @param batch - The batch to process
   * @param batchIndex - The index of the batch
   */
  private async createWorker(batch: T[], batchIndex: number): Promise<void> {
    const worker = this.processBatch(batch, batchIndex);
    this.activeWorkersPromises.add(worker);
    await worker.finally(() => this.activeWorkersPromises.delete(worker));
  }

  /**
   * Main method that orchestrates the batch processing.
   * Manages concurrent workers and processes all batches.
   * @returns Promise resolving to the results and errors from all batches
   */
  public async process(): Promise<{ results: R[]; errors: BatchProcessingError[] }> {
    const { concurrency = 5 } = this.options;
    let nextBatchIndex = 0;

    try {
      while (
        (nextBatchIndex < this.batches.length || this.activeWorkersPromises.size > 0) &&
        !this.aborted
      ) {
        while (
          this.activeWorkersPromises.size < concurrency &&
          nextBatchIndex < this.batches.length &&
          !this.aborted
        ) {
          this.checkAbort(nextBatchIndex);
          const batchIndex = nextBatchIndex++;
          void this.createWorker(this.batches[batchIndex], batchIndex);
        }

        if (this.activeWorkersPromises.size > 0) {
          await Promise.race(this.activeWorkersPromises);
        }
      }
    } catch (error) {
      if (!(error instanceof BatchAbortError)) throw error;
    }

    await Promise.allSettled(this.activeWorkersPromises);
    return { results: this.results, errors: this.errors };
  }
}

/**
 * A utility function for processing arrays of items in batches with concurrent execution.
 *
 * Features:
 * - Processes items in configurable batch sizes
 * - Supports concurrent batch processing
 * - Progress tracking
 * - Error handling per batch
 * - Ability to stop on first error
 * - Cancellation support via AbortSignal
 *
 * @template T The type of items to be processed
 * @template R The type of results returned after processing
 * @param {T[]} items - Array of items to process
 * @param {(batch: T[]) => Promise<R[]>} processor - Async function to process each batch
 * @param {BatchOptions<T, R>} options - Configuration options for batch processing:
 *   @param {number} [options.batchSize=10] - Number of items to process in each batch
 *   @param {number} [options.concurrency=5] - Maximum number of concurrent batch operations
 *   @param {boolean} [options.stopOnError=false] - Whether to stop all processing when a batch fails
 *   @param {Function} [options.onBatchSuccess] - Callback after each successful batch, receives (results, batch, batchIndex)
 *   @param {Function} [options.onBatchError] - Callback when a batch fails, receives (error, batch, batchIndex)
 *   @param {Function} [options.onProgress] - Progress tracking callback, receives ({ completed, total, percent })
 *   @param {AbortSignal} [options.signal] - AbortSignal for cancelling the operation
 *
 * @returns {Promise<{ results: R[]; errors: BatchProcessingError[] }>}
 *          Object containing processed results and any errors that occurred
 *
 * @example
 * ```typescript
 * // Example: Process array of numbers in batches
 * const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
 *
 * const result = await workerBatcher(
 *   numbers,
 *   async (batch) => {
 *     // Process each batch (e.g., multiply by 2)
 *     return batch.map(n => n * 2);
 *   },
 *   {
 *     batchSize: 3,         // Process 3 items at a time
 *     concurrency: 2,       // Run 2 batches in parallel
 *     stopOnError: false,   // Continue processing if a batch fails
 *     onProgress: ({ percent }) => console.log(`Progress: ${percent}%`),
 *     onBatchSuccess: (results, batch, index) => console.log(`Batch ${index} processed:`, results),
 *     onBatchError: (error, batch, index) => console.error(`Batch ${index} failed:`, error),
 *     signal: abortController.signal // Optional abort signal
 *   }
 * );
 * ```
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

  if (options.signal?.aborted) {
    const abortError = new BatchAbortError(items, 0);
    return { results: [], errors: [abortError] };
  }

  const batches = Array.from({ length: Math.ceil(items.length / batchSize) }, (_, index) =>
    items.slice(index * batchSize, (index + 1) * batchSize)
  );

  const batchProcessor = new BatchProcessor(batches, processor, options);
  return await batchProcessor.process();
}

export default workerBatcher;
