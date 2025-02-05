# Worker Batcher

A powerful utility for parallel array processing with controlled concurrency and batch size.

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

try {
  const { results } = await workerBatcher(
    items,
    async (batch) => {
      return batch.map(x => x * 2);
    },
    {
      signal: controller.signal
    }
  );
} catch (error) {
  if (error.message === 'Operation was aborted') {
    console.log('Processing was cancelled');
  }
}

// Cancel processing
controller.abort();
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
  
  // AbortSignal for cancelling the operation
  signal?: AbortSignal;
  
  // Called after each successful batch
  onBatchSuccess?: (results: R[], batch: T[], index: number) => void;
  
  // Called when a batch fails
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
  results: R[];          // Array of successfully processed items
  errors: Error[];       // Array of errors from failed batches
}>
```

## Error Handling

The library provides a `BatchProcessingError` class for detailed error information:

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

# Check bundle size
bun run size

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
