# Worker Function Node

## Purpose & Use Cases

The Worker Function node executes JavaScript code in isolated worker threads by default (or child processes when configured), preventing CPU-intensive operations from blocking the Node-RED event loop. Unlike the standard Function node which runs synchronously on the main thread, this node offloads execution to a pool of workers, keeping your Node-RED instance responsive even during heavy computations.

This node is ideal for operations that would otherwise cause Node-RED to become unresponsive: cryptographic operations, prime number calculations, large dataset transformations, image/file processing, and any computation that takes more than 10-20ms to complete. For simple operations like basic math or property transformations, continue using the standard Function node to avoid the ~5-10ms overhead of worker communication (child process mode is higher).

**Real-World Applications:**

- **Cryptographic operations**: Hashing, encryption, key derivation (bcrypt, scrypt, PBKDF2)
- **Data transformations**: Processing large JSON datasets, CSV parsing, XML transformations
- **Image processing**: Resizing, format conversion, metadata extraction (with sharp, jimp)
- **Mathematical computations**: Prime number generation, statistical analysis, matrix operations
- **File operations**: Reading/parsing large files, compression/decompression
- **Text processing**: Large regex operations, string manipulation on big text blocks
- **Scientific computing**: Simulations, numerical analysis, data modeling


## Input/Output Specification

### Inputs

The node accepts any standard Node-RED message object. The `msg` object is serialized and sent to the worker for processing.

**Supported input types:**
- **Primitives**: strings, numbers, booleans, null
- **Objects**: Plain JavaScript objects (must be serializable)
- **Arrays**: Arrays of any serializable types
- **Buffers**: Binary data (zero-copy transfer in worker threads, shared memory fallback)
- **Nested structures**: Deep object hierarchies are fully supported

**Not supported:**
- Functions (cannot be serialized)
- Symbols
- Circular references (will cause serialization error)
- Class instances (converted to plain objects)

**Message optimization**: The node analyzes your code to detect which `msg.*` properties are referenced and only transfers those properties to the worker. This optimization reduces serialization overhead for messages with many properties when only a few are used.

### Outputs

The node supports 0-10 output ports, configured in the Setup tab.

**Single output (default):**
```javascript
// Return the modified message
msg.payload = msg.payload * 2;
return msg;
```

**Multiple outputs:**
```javascript
// Return array of messages (one per output)
if (msg.payload > 100) {
    return [msg, null];  // Send to output 1 only
} else {
    return [null, msg];  // Send to output 2 only
}
```

**Stop the flow:**
```javascript
// Return null to prevent any output
if (!msg.payload) {
    return null;
}
return msg;
```

**Send multiple messages to one output:**
```javascript
// Return array within array
return [[msg1, msg2, msg3]];  // Three messages to output 1
```

## Configuration Options

### Input/Output Paths

| Property | Description | Default |
|----------|-------------|---------|
| Input | Single input port accepting any `msg` object | 1 input |
| Outputs | Number of output ports (0-10) | 1 output |

### Behavior Settings

#### Outputs
- **Range**: 0-10
- **Default**: 1
- **Behavior**: Determines how many output ports the node exposes. Use array returns to route messages to specific outputs.

#### Timeout
- **Range**: 1,000 - 300,000 ms
- **Default**: 30,000 ms (30 seconds)
- **Behavior**: Maximum execution time for user code. If exceeded, the worker is terminated and an error is thrown. The timeout starts after message serialization completes.

#### Runtime
- **Options**: `worker_threads`, `child_process`
- **Default**: `worker_threads`
- **Behavior**: Worker threads are fastest. Use child processes for native modules that require the main thread (e.g., `gl`), with higher overhead.

### Worker Pool Settings

#### Workers
- **Range**: 1-16
- **Default**: 3
- **Behavior**: Fixed number of workers maintained by this node. Each worker-function node maintains its own independent pool. More workers allow more parallel executions but consume more memory (~10-20MB per worker).

**Guidance:**
- 1-2 workers: Low-volume flows or memory-constrained environments
- 3-4 workers: Typical use cases with moderate parallelism
- 8-16 workers: High-throughput scenarios with many concurrent messages

#### Queue Size
- **Range**: 10-1,000
- **Default**: 100
- **Behavior**: Maximum messages that can wait when all workers are busy. When the queue is full, new messages are rejected with a "Task queue full" error. Messages in the queue are processed FIFO (first-in, first-out).

### Modules Settings

The Modules section in the Setup tab allows you to add external npm dependencies that will be available in your code.

#### Adding Modules

1. Open the node configuration dialog
2. Switch to the **Setup** tab
3. In the **Modules** section, click the **+ add** button
4. Enter the **Module** name (npm package name, e.g., `lodash`)
5. Enter the **Import as** variable name (e.g., `_`)

#### Auto-Installation Behavior

When the node starts:
1. It checks if each configured module is available
2. If a module is missing, it automatically runs `npm install <module>` in the Node-RED user directory (`~/.node-red`)
3. Installation logs appear in the Node-RED console
4. If installation fails, an error is logged and the module will be unavailable

**Notes:**
- Installation happens synchronously during node initialization
- The NODE_RED_HOME environment variable can override the install location
- Scoped packages are supported (e.g., `@scope/package`)
- Version specifiers are supported (e.g., `lodash@4.17.21`)

#### Using Modules in Code

Configured modules are injected as variables in your code. You do not need to use `require()` for configured modules.

**Example with lodash:**

Setup tab configuration:
| Module | Import as |
|--------|-----------|
| lodash | _ |

Function tab code:
```javascript
// _ is available directly - no require needed
const result = _.groupBy(msg.payload, 'category');
msg.payload = result;
return msg;
```

**Example with moment:**

Setup tab configuration:
| Module | Import as |
|--------|-----------|
| moment | moment |

Function tab code:
```javascript
msg.timestamp = moment().format('YYYY-MM-DD HH:mm:ss');
msg.payload.createdAt = moment(msg.payload.date).fromNow();
return msg;
```

**Example with multiple modules:**

Setup tab configuration:
| Module | Import as |
|--------|-----------|
| lodash | _ |
| uuid | uuid |
| crypto-js | CryptoJS |

Function tab code:
```javascript
// All modules available as variables
msg.payload = _.map(msg.payload, item => ({
    ...item,
    id: uuid.v4(),
    hash: CryptoJS.SHA256(item.name).toString()
}));
return msg;
```

#### Variable Name Restrictions

The "Import as" variable name must be:
- A valid JavaScript identifier (starts with letter, `_`, or `$`)
- Not a reserved name: `msg`, `require`, `console`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `Buffer`, `process`

## Performance Notes

### Worker Thread Overhead

Each message incurs approximately **5-10ms overhead** for:
- Message serialization to worker
- Worker context setup
- Result deserialization back to main thread

**Note:** Child process runtime has higher overhead due to full process IPC and larger memory footprint.

**Recommendation:** Only use the worker-function node when your code execution time exceeds 10-20ms. For simple operations, the standard function node is more efficient.

### Native Backend Subsystem

The node uses Node.js worker_threads module by default, with additional optimizations:

- **Code Caching**: User code is compiled once per unique code string and cached (LRU cache with 100 entry limit). Subsequent executions reuse the compiled AsyncFunction.
- **Message Optimization**: Only `msg.*` properties referenced in your code are serialized and sent to workers.
- **Buffer Transfer**: Worker threads use zero-copy transfer for eligible Buffers. Child process mode and non-transferable buffers fall back to filesystem-based shared memory.

### Processing Characteristics

- **Parallel Execution**: Multiple messages process simultaneously up to the worker count
- **Queue Management**: Messages exceeding worker capacity are queued (FIFO)
- **Auto-Recovery**: Crashed or timed-out workers are automatically replaced
- **Isolation**: Each worker runs in a separate V8 isolate with its own memory
- **No Blocking**: Main Node-RED event loop remains responsive regardless of worker activity
- **Memory Usage**: Each worker uses approximately 10-20MB of memory

### Performance Metrics

Every processed message includes timing information in `msg.performance[nodeName]`:

```javascript
msg.performance["my worker function"] = {
    transferToWorkerMs: 1.23,  // Time to restore buffers in worker
    executionMs: 45.67,        // Time to execute user code
    transferToMainMs: 0.89,    // Time to serialize result
    totalMs: 52.34             // End-to-end processing time
}
```

**Metric descriptions:**

| Metric | Description |
|--------|-------------|
| `transferToWorkerMs` | Time spent restoring buffers before code execution |
| `executionMs` | Time spent executing your JavaScript code |
| `transferToMainMs` | Time spent serializing the result for transfer back to main thread |
| `totalMs` | Total wall-clock time from message receipt to output |

## Shared Memory

### How Large Buffers Are Handled

When messages contain `Buffer` objects, the node prefers zero-copy transfer in worker threads. If that isn't possible (or when running in child process mode), it falls back to shared memory:

1. **Detection**: Buffer objects in the message are identified during serialization
2. **Transfer (worker threads)**: Buffers are transferred by ownership when safe (zero-copy)
3. **Fallback (child process / non-transferable)**: Buffers are written to shared memory
4. **Restoration**: The worker restores Buffers before executing your code
5. **Cleanup**: Shared memory files are automatically deleted after task completion

### Platform-Specific Behavior

| Platform | Shared Memory Path | Characteristics |
|----------|-------------------|-----------------|
| Linux | `/dev/shm` | RAM-backed tmpfs, zero disk I/O |
| macOS | `os.tmpdir()` | Disk-based, may involve I/O |
| Windows | `os.tmpdir()` | Disk-based, may involve I/O |

### File Naming Convention

Shared memory files follow this pattern:
```
rosepetal-async-{pid}-{taskId}-{bufferIndex}-{timestamp}-{random}.bin
```

### Cleanup and Orphan Detection

- **Normal cleanup**: Files are deleted immediately after task completion
- **Orphan detection**: On startup, files older than 1 hour matching the naming pattern are deleted
- **Fallback**: If shared memory write fails, buffers are base64-encoded (slower but reliable)

### Buffer Performance Tips

- Zero-copy transfer avoids file I/O for large Buffers in worker threads
- Shared memory remains the fallback path when transfer isn't available
- Event loop never blocks, even when processing multi-MB buffers
- For best performance on Linux, ensure `/dev/shm` has sufficient space

## Limitations

### Not Available in Worker Code

| Feature | Reason | Alternative |
|---------|--------|-------------|
| `node.send()` | Node instance not available | Use `return` statement |
| `env.get()` | Environment helper not available | Access `process.env` directly |

### Context + Node Helpers (Snapshot)

`context.get/set`, `flow.get/set`, and `global.get/set` are available with snapshot semantics. Reads come from the snapshot taken at the start of execution; writes are applied after your function completes. The snapshot only includes literal keys detected in your code (e.g., `flow.get("count")`). Store-specific context selection is not supported (default store only). `node.warn/error/log()` are collected and forwarded to the main thread.

Example:
```javascript
const count = flow.get('count') || 0;
flow.set('count', count + 1);
node.warn(`count=${count + 1}`);
```

### Serialization Requirements

The `msg` object must be serializable:
- **No functions**: Functions cannot be transferred between threads
- **No symbols**: Symbols are not serializable
- **No circular references**: Will cause serialization to fail
- **Class instances**: Converted to plain objects (prototype chain lost)

### Other Limitations

- **~5-10ms overhead**: Not suitable for sub-millisecond operations
- **Memory usage**: Each worker consumes ~10-20MB
- **Limited node access**: `node.warn/error/log()` are available, but other node methods are not
- **Snapshot context**: Context reads are from the snapshot; updates apply after execution

## Real-World Examples

### CPU-Intensive Prime Number Calculation

```
[inject: 50000] -> [worker-function: Calculate Primes] -> [debug]
```

```javascript
// Calculate all prime numbers up to msg.payload
// This would freeze Node-RED if run in standard function node

function isPrime(n) {
    if (n <= 1) return false;
    if (n <= 3) return true;
    if (n % 2 === 0 || n % 3 === 0) return false;
    for (let i = 5; i * i <= n; i += 6) {
        if (n % i === 0 || n % (i + 2) === 0) return false;
    }
    return true;
}

const limit = msg.payload;
const primes = [];

for (let i = 2; i <= limit; i++) {
    if (isPrime(i)) primes.push(i);
}

msg.payload = primes;
msg.count = primes.length;
return msg;
```

Prevents event loop blocking during heavy computation.

### Password Hashing with bcrypt

```
[http-in: POST /register] -> [worker-function: Hash Password] -> [database] -> [http-response]
```

Setup tab - Modules:
| Module | Import as |
|--------|-----------|
| bcrypt | bcrypt |

Function tab:
```javascript
// Hash password with bcrypt (CPU-intensive)
const saltRounds = 12;
const hash = await bcrypt.hash(msg.payload.password, saltRounds);

msg.payload.passwordHash = hash;
delete msg.payload.password;  // Remove plaintext
return msg;
```

bcrypt with 12 rounds takes ~300ms - offloading prevents blocking.

### Large JSON Dataset Processing

```
[file-in: data.json] -> [worker-function: Process Data] -> [split] -> [database]
```

Setup tab - Modules:
| Module | Import as |
|--------|-----------|
| lodash | _ |

Function tab:
```javascript
// Process large dataset with lodash
const data = JSON.parse(msg.payload);

// Group, filter, and transform (CPU-intensive for large datasets)
const processed = _.chain(data)
    .filter(item => item.status === 'active')
    .groupBy('category')
    .mapValues(items => ({
        count: items.length,
        total: _.sumBy(items, 'value'),
        average: _.meanBy(items, 'value'),
        items: _.sortBy(items, 'date')
    }))
    .value();

msg.payload = processed;
return msg;
```

Handles datasets with thousands of records without blocking.

### Image Metadata Extraction

```
[file-in: photo.jpg] -> [worker-function: Extract EXIF] -> [debug]
```

Setup tab - Modules:
| Module | Import as |
|--------|-----------|
| exif-parser | ExifParser |

Function tab:
```javascript
// Extract EXIF metadata from image buffer
const parser = ExifParser.create(msg.payload);
const result = parser.parse();

msg.exif = {
    make: result.tags.Make,
    model: result.tags.Model,
    datetime: result.tags.DateTimeOriginal,
    gps: result.tags.GPSLatitude ? {
        lat: result.tags.GPSLatitude,
        lon: result.tags.GPSLongitude
    } : null,
    dimensions: {
        width: result.imageSize.width,
        height: result.imageSize.height
    }
};

return msg;
```

Binary buffer transferred efficiently (zero-copy when possible).

### Cryptographic Hash Generation

```
[inject: "secret data"] -> [worker-function: Generate Hashes] -> [debug]
```

Function tab (no external modules needed):
```javascript
const crypto = require('crypto');
const data = msg.payload;

// Generate multiple hash types
msg.hashes = {
    md5: crypto.createHash('md5').update(data).digest('hex'),
    sha1: crypto.createHash('sha1').update(data).digest('hex'),
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    sha512: crypto.createHash('sha512').update(data).digest('hex')
};

return msg;
```

Uses built-in crypto module - no setup required.

### Conditional Routing with Multiple Outputs

```
[mqtt-in] -> [worker-function: Route by Priority (3 outputs)] -> [high-priority-queue]
                                                              -> [normal-queue]
                                                              -> [low-priority-queue]
```

Configuration: Outputs = 3

Function tab:
```javascript
// Route messages based on computed priority
const data = msg.payload;

// Complex priority calculation (example)
let priority = 0;
if (data.urgent) priority += 50;
if (data.customer_tier === 'premium') priority += 30;
if (data.value > 1000) priority += 20;

msg.priority = priority;

// Route to appropriate output
if (priority >= 70) {
    return [msg, null, null];  // High priority (output 1)
} else if (priority >= 30) {
    return [null, msg, null];  // Normal priority (output 2)
} else {
    return [null, null, msg];  // Low priority (output 3)
}
```

Routes messages to different outputs based on computed criteria.

## Common Issues & Troubleshooting

### Task Queue Full Error

**Issue**: Messages are rejected with "Task queue full" error.

**Cause**: All workers are busy and the queue has reached its maximum size (default: 100).

**Solution**:
- Increase the Queue Size in the Setup tab
- Increase the number of Workers to process messages faster
- Add flow control upstream (e.g., delay node, rate limit)
- Optimize your code to execute faster

### Execution Timeout Error

**Issue**: Tasks fail with "Execution timeout" error.

**Cause**: User code took longer than the configured timeout (default: 30 seconds).

**Solution**:
- Increase the Timeout value in the Setup tab
- Optimize your code for better performance
- Break large operations into smaller chunks
- Check for infinite loops in your code

### Module Not Found Error

**Issue**: Module fails to load with "Cannot find module" error.

**Cause**: The npm module is not installed or installation failed.

**Solution**:
- Check Node-RED console for installation errors
- Manually install the module: `cd ~/.node-red && npm install <module>`
- Verify the module name is spelled correctly
- For scoped packages, use the full name: `@scope/package`

### Serialization Errors

**Issue**: Message fails to serialize with circular reference or function errors.

**Cause**: The `msg` object contains non-serializable data (functions, circular refs, symbols).

**Expected**: Only serializable data should be included in `msg`.

**Solution**:
- Remove functions from `msg` before sending
- Break circular references in objects
- Convert class instances to plain objects with `JSON.parse(JSON.stringify(obj))`

### Worker Crash/Restart

**Issue**: Workers crash and restart frequently.

**Cause**: Unhandled exceptions or promise rejections in user code.

**Solution**:
- Wrap code in try/catch blocks
- Handle promise rejections with `.catch()` or try/catch with async/await
- Check for null/undefined access errors
- Use `console.error()` to debug issues

### High Memory Usage

**Issue**: Node-RED process uses excessive memory.

**Cause**: Too many workers configured or memory leaks in user code.

**Solution**:
- Reduce the number of workers (each uses ~10-20MB)
- Check for memory leaks in your code (unreleased references, growing arrays)
- Monitor with `msg.performance` to identify slow operations
- Consider processing large datasets in smaller batches

### Status Shows Yellow/Red

**Issue**: Node status shows yellow or red indicator.

**Expected**: Green = normal, Yellow = queue > 50, Red = queue > 90% or error.

**Solution**:
- Yellow: Queue is getting full - consider adding workers or upstream flow control
- Red: Queue almost full or recent error - check logs and consider scaling up
- Ring shape: All workers busy with backlog - increase workers or optimize code
