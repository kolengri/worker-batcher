# Worker Batcher

A powerful utility for parallel array processing with controlled concurrency and batch size. Perfect for scenarios like:

- Making parallel API requests without overloading the server by controlling batch size and concurrency
- Processing large datasets in chunks while maintaining optimal performance
- Fetching data for multiple users/items simultaneously with rate limiting
- Uploading multiple files in parallel with progress tracking

For example, when fetching data for 1000 users, instead of making 1000 simultaneous API calls that could overwhelm the server, you can process them in batches of 10 with max 3 concurrent batches.

[![NPM](https://img.shields.io/npm/v/worker-batcher.svg)](https://www.npmjs.com/package/worker-batcher)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![Badges](https://badgen.net/npm/license/worker-batcher)](https://www.npmjs.com/package/worker-batcher)
[![Badges](https://badgen.net/npm/dependents/worker-batcher)](https://www.npmjs.com/package/worker-batcher)
[![Badges](https://badgen.net/npm/types/worker-batcher)](https://www.npmjs.com/package/worker-batcher)
[![Badges](https://badgen.net/github/issues/kolengri/worker-batcher)](https://www.npmjs.com/package/worker-batcher)
[![Badges](https://badgen.net/bundlephobia/min/worker-batcher)](https://bundlephobia.com/result?p=worker-batcher)
[![Badges](https://badgen.net/bundlephobia/minzip/worker-batcher)](https://bundlephobia.com/result?p=worker-batcher)

## Features

- 🚀 Parallel data processing
- 📦 Batch processing
- 🎛 Configurable concurrency
- 🔄 Progress tracking
- ⚡ TypeScript support
- 🛑 Operation cancellation
- 🎯 Detailed error handling

## Installation

```bash
bun add worker-batcher
# or
npm install worker-batcher
```

## Usage

### Basic Example

```typescript
import { workerBatcher } from 'worker-batcher';

const items = [1, 2, 3, 4, 5, 6];

const { results, errors } = await workerBatcher(
  items,
  async (batch) => {
    return batch.map(x => x * 2);
  },
  {
    batchSize: 2,
    concurrency: 3
  }
);

console.log(results); // [2, 4, 6, 8, 10, 12]
```

### Progress Tracking

```typescript
const { results } = await workerBatcher(
  items,
  async (batch) => {
    return batch.map(x => x * 2);
  },
  {
    batchSize: 2,
    onProgress: ({ percent, completed, total }) => {
      console.log(`Progress: ${percent}% (${completed}/${total})`);
    },
    onBatchSuccess: (results, batch, index) => {
      console.log(`Batch ${index} processed:`, results);
    }
  }
);
```

### Error Handling

```typescript
const { results, errors } = await workerBatcher(
  items,
  async (batch) => {
    if (batch.includes(3)) {
      throw new Error('Invalid item');
    }
    return batch.map(x => x * 2);
  },
  {
    onBatchError: (error, batch, index) => {
      console.error(`Batch ${index} failed:`, error.message);
    }
  }
);

// Check for errors
if (errors.length > 0) {
  console.error('Some batches failed:', errors);
}
```

### Cancellation

```typescript
const controller = new AbortController();

const { results, errors } = await workerBatcher(
  items,
  async (batch) => {
    return batch.map(x => x * 2);
  },
  {
    signal: controller.signal,
    onBatchSuccess: (results, batch, index) => {
      console.log(`Batch ${index} completed:`, results);
    },
    onBatchError: (error, batch, index) => {
      if (error instanceof BatchAbortError) {
        console.log('Remaining items will not be processed');
      }
    }
  }
);

// Cancel processing of new batches
// Current batches will complete
controller.abort();

// Check results after cancellation
console.log('Completed results:', results);  // Contains results from completed batches
console.log('Errors:', errors);  // Contains BatchAbortError for unprocessed items
```

## TypeScript Support

This package includes TypeScript type definitions. No additional @types package is required.

```typescript
import { workerBatcher, BatchOptions } from 'worker-batcher';

const options: BatchOptions<number, number> = {
  batchSize: 2,
  concurrency: 3
};

const { results, errors } = await workerBatcher(
  [1, 2, 3],
  async (batch) => batch.map(x => x * 2),
  options
);
```

## API Reference

### workerBatcher<T, R>(items, processor, options)

Processes an array of items in batches with controlled concurrency.

#### Parameters

- `items: T[]` - Array of items to process
- `processor: (batch: T[]) => Promise<R[]>` - Async function to process each batch
- `options: BatchOptions<T, R>` - Configuration options

#### Options

```typescript
interface BatchOptions<T, R> {
  // Number of items to process in one batch (default: 10)
  batchSize?: number;
  
  // Maximum number of concurrent batch operations (default: 5)
  concurrency?: number;
  
  // AbortSignal for graceful cancellation
  // When aborted, current batches will complete
  // and function will return partial results
  signal?: AbortSignal;
  
  // Called after each successful batch
  onBatchSuccess?: (results: R[], batch: T[], index: number) => void;
  
  // Called when a batch fails or when remaining items are aborted
  onBatchError?: (error: Error, batch: T[], index: number) => void;
  
  // Called to report progress
  onProgress?: (progress: {
    completed: number;
    total: number;
    percent: number;
  }) => void;
}
```

#### Returns

```typescript
Promise<{
  results: R[];     // Array of successfully processed items (including partial results if aborted)
  errors: Error[];  // Array of errors from failed batches and BatchAbortError for remaining items if aborted
}>
```

## Error Handling

The library provides error classes for detailed error information:

### BatchProcessingError

Used when a batch fails during processing:

```typescript
class BatchProcessingError extends Error {
  constructor(
    message: string,
    public readonly batch: unknown[],
    public readonly batchIndex: number,
    public readonly originalError: Error
  )
}
```

### BatchAbortError 

Added to errors array when operation is cancelled via AbortSignal:

```typescript
class BatchAbortError extends BatchProcessingError {
  constructor(
    batch: unknown[],
    batchIndex: number
  )
}
```

Example handling both error types:

```typescript
const { results, errors } = await workerBatcher(
  items,
  async (batch) => {
    return batch.map(x => x * 2);
  },
  {
    signal: controller.signal,
    onBatchError: (error, batch, index) => {
      if (error instanceof BatchProcessingError) {
        console.error(`Batch ${index} failed:`, error.originalError.message);
      } else if (error instanceof BatchAbortError) {
        console.log('Remaining items will not be processed');
      }
    }
  }
);

// Check for abort
const abortError = errors.find(error => error instanceof BatchAbortError);
if (abortError) {
  console.log('Processing was cancelled, but partial results are available');
}
```

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type checking
bun run type-check

# Build package
bun run build

# Clean build artifacts
bun run clean

# Prepare for publishing (runs tests, type check, build and size check)
bun run prepublishOnly
```

## Publishing

Before publishing, make sure to:

1. Update version in package.json
2. Run prepublishOnly script to ensure everything is working
3. Create git tag for the version

```bash
# Update version
bun version patch # or minor, or major

# Prepare and publish
bun run prepublishOnly
bun publish
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
