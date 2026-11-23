---
title: "Worker Function Node - JavaScript in Worker Threads"
description: "Reference of the worker-function node for Node-RED: function code that runs in a pool of worker threads or child processes, with its options, external modules, buffer transfer, limitations, examples and troubleshooting. Part of @rosepetal/node-red-contrib-async-function."
sidebar_position: 1
head:
  - - meta
    - name: "keywords"
      content: "node-red, worker function, function node, worker threads, child process, worker pool, queue, timeout, npm modules, shared memory, rosepetal"
  - - meta
    - property: "og:title"
      content: "Worker Function Node - @rosepetal/node-red-contrib-async-function"
  - - meta
    - property: "og:description"
      content: "Reference of the worker-function node for Node-RED: function code that runs in a pool of worker threads or child processes."
---

# Worker Function Node

## Purpose & Use Cases

The Worker Function node executes JavaScript code in isolated worker threads by default (or child processes when configured), preventing CPU-intensive operations from blocking the Node-RED event loop. Unlike the standard Function node which runs synchronously on the main thread, this node offloads execution to a pool of workers, keeping your Node-RED instance responsive even during heavy computations.

This node is ideal for operations that would otherwise cause Node-RED to become unresponsive: cryptographic operations, prime number calculations, large dataset transformations, image/file processing. For simple operations like basic math or property transformations, continue using the standard Function node: copying the message to a worker and the result back takes longer than such an operation (and longer still with the Child Process runtime).

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

The node accepts any standard Node-RED message object. The `msg` properties the code uses are copied to the worker for processing (see [Message Handling](#message-handling)).

**Supported input types:**
- **Primitives**: strings, numbers, booleans, null
- **Objects**: Plain JavaScript objects
- **Arrays**: Arrays of any of these types
- **Buffers**: Binary data, moved without copying or through shared memory depending on the runtime (see [Shared Memory](#shared-memory)). Typed arrays such as `Float32Array` arrive as a Buffer with their bytes
- **Nested structures**: Deep object hierarchies and circular references are kept

**Dropped or changed on the way to the worker (and on the way back):**
- Functions and symbols are dropped
- Properties set to `undefined` are dropped; `undefined` inside an array becomes `null`
- Class instances are converted to plain objects with their own enumerable properties: a `Date`, a `Map` or a `Set` arrives as an empty object `{}`

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

Returning `null` or nothing sends no message.

### Message Handling

The node looks in the code for the properties written as `msg.<name>` or `msg["<name>"]` and copies only those to the worker, plus `msg._msgid`. When the code names no property this way (for example `return msg;` alone), the whole message is copied.

Each message sent is the incoming message with the properties of the returned object written over it, plus [`msg.performance`](#performance-metrics). As a result:

- Properties the code does not name stay in the main thread and reach the output unchanged. A message from an **http in** node keeps its `msg.req` and `msg.res` untouched, for the **http response** node, when the code names its other properties (`msg.payload`) and not these two.
- A property read in any other way (`const { topic } = msg`, `Object.keys(msg)`, a helper function that receives `msg`) is missing in the worker when the code names other properties as `msg.<name>`. Write it as `msg.topic` somewhere in the code.
- Deleting a property (`delete msg.topic`) or setting it to `undefined` does not remove it from the output: it keeps its incoming value.
- Returning a new object (`return { payload: 42 };`) sends the incoming message with `payload` replaced, not a message with `payload` alone.

## Configuration Options

The edit dialog has a **Name** field (the label on the workspace; `worker function` when empty) and two tabs: **Function**, the code editor, which opens first, and **Setup**, with the sections **Behavior** (Outputs, Timeout, Runtime), **Worker Pool** (Workers, Queue Size), **Modules** and **Actions** (Restart Workers).

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
- **Behavior**: Maximum time for one message. If exceeded, the message fails with `Execution timeout`, and its worker is terminated and replaced by a new one. The timeout starts after message serialization completes, when the message is sent to a worker: time spent waiting in the queue does not count.

#### Runtime
- **Options**: **Worker Threads (fastest)** (`worker_threads`), **Child Process (native modules)** (`child_process`)
- **Default**: Worker Threads
- **Behavior**: Worker threads are fastest. Use child processes for native modules that require the main thread (e.g., `gl`), with higher overhead: each worker is then a separate Node.js process. Buffers travel differently in each runtime, see [Shared Memory](#shared-memory).

### Worker Pool Settings

#### Workers
- **Range**: 1-16
- **Default**: 3
- **Behavior**: Fixed number of workers maintained by this node. Each worker-function node maintains its own independent pool, started when the flow is deployed. More workers allow more parallel executions but consume more memory. For CPU-bound code, more workers than CPU cores do not make the node faster.

#### Queue Size
- **Range**: 10-1,000
- **Default**: 100
- **Behavior**: Maximum messages that can wait when all workers are busy. When the queue is full, new messages are rejected with a "Task queue full" error. Messages in the queue are processed FIFO (first-in, first-out). Messages that are running do not count, so the node holds at most Workers + Queue Size messages.

### Actions

#### Restart Workers

The **Restart Workers** button stops the workers of the deployed node and starts new ones with its deployed configuration, which reloads the modules (for example after updating one with npm) and clears whatever the code kept in the worker between messages. Messages waiting in the queue fail with `Worker pool shutdown`, and messages that are running at that moment are dropped. The button shows `✓ Workers restarted`, or `✗` followed by the error: `Node not found or pool not initialized` when the node has not been deployed yet or its pool could not be created.

### Modules Settings

The Modules section in the Setup tab allows you to add external npm dependencies that will be available in your code.

#### Adding Modules

1. Open the node configuration dialog
2. Switch to the **Setup** tab
3. In the **Modules** section, click the **+ add** button
4. Enter the **Module** name (npm package name, e.g., `lodash`)
5. Enter the **Import as** variable name (e.g., `_`). While this field is empty, any change to **Module** fills it in from the module name as it is at that moment, without the scope and in camelCase: a pasted `crypto-js` gives `cryptoJs`, but typing `lodash` letter by letter leaves `l`. Check it before closing the dialog

A row with an empty **Module** or **Import as** is not saved.

#### Auto-Installation Behavior

The node hands its module list to Node-RED the same way the standard function node does, so Node-RED takes care of the installation:

1. When the flows start, Node-RED installs the listed modules it has not installed yet, as it does for the modules of a function node. Built-in Node.js modules (`crypto`, `zlib`) can be listed too and are not installed
2. Every worker loads the modules from the `node_modules` folder of the Node-RED user directory (`~/.node-red` by default), which is where Node-RED 4 installs them
3. If a module cannot be loaded, the workers do not start: the node logs `Failed to initialize worker pool: Worker failed to load module(s): <module> (<Import as>): <reason>` and its status shows `Init failed`

**Notes:**
- When `functionExternalModules` is `false` in the Node-RED settings, a node with modules does not start: it logs `External modules are disabled by Node-RED settings.` and its status shows `Modules disabled`
- Scoped packages are supported (e.g., `@scope/package`)
- Version specifiers are not supported: with `lodash@4.17.21` the module is installed, but the workers cannot load it and the node reports `Init failed`. Enter the package name alone (`lodash`)

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

The editor outlines a name that breaks these rules in red but saves it anyway. A name that is not an identifier (`crypto-js`) makes every message fail with a `SyntaxError`; a reserved name hides the variable of the same name in the code. Avoid `node`, `flow`, `global` and `context` as well: the editor accepts them, but the module then takes the place of that helper.

## Status and Errors

The status under the node, for example `Active: 2/3 | Queue: 5`, is refreshed every 2 seconds once the workers have started:

| Status | Meaning |
|--------|---------|
| `Active: 2/3` | Workers running a message, out of the workers of the node |
| `Queue: 5` | Messages waiting in the queue |
| `SHM: 1` | Shared memory files in use (Child Process runtime), shown only when there is at least one |
| Green dot | Normal operation |
| Yellow dot | More than 50 messages in the queue |
| Red dot | The queue holds 90% of **Queue Size** or more |
| Ring instead of dot | Every worker is busy and there are messages in the queue |
| `Error: ` and the first 20 characters of the error, red | A message has just failed; the normal status returns after 3 seconds |
| `Init failed`, red | The workers could not start, see the log (`Failed to initialize worker pool: …`) |
| `Modules disabled`, red | The node lists modules and `functionExternalModules` is `false` in the Node-RED settings |
| `Pool creation failed`, red | The worker pool could not be created, see the log |

When a message fails, the node reports two errors with the incoming message: `Worker function error: <message>`, then the error itself as text (for example `Error: <message>`). A **catch** node therefore receives the message twice, once with each text in `msg.error.message`; without a catch node, both go to the log.

| Error | Cause |
|-------|-------|
| The error thrown by the code | The code threw an error or returned a rejected promise |
| `Uncaught exception: <message>` | An error thrown in a callback (`setTimeout`, an event handler) while the message was running |
| `Unhandled rejection: <reason>` | A promise that nothing awaited was rejected while the message was running |
| `Execution timeout` | The message ran longer than **Timeout** |
| `Task queue full` | Every worker was busy and the queue already held **Queue Size** messages |
| `Worker error: <reason>` | The worker ended while running the message, for example `Worker exited with code 1`; it is replaced by a new one |
| `Worker pool shutdown` | The message was waiting in the queue when the node was stopped, redeployed or restarted |
| `Worker failed to load module(s): …` | The workers could not start (status `Init failed`): each message tries to start them again |

An error thrown in a callback after its message has finished is not reported.

## Performance Notes

### Worker Thread Overhead

Each message has a cost on top of the code itself:
- Message serialization to worker
- Worker context setup
- Result deserialization back to main thread

**Note:** Child process runtime has higher overhead due to full process IPC and larger memory footprint.

**Recommendation:** Use the worker-function node for code that runs long enough for this cost not to matter: compare `executionMs` with `totalMs` in [`msg.performance`](#performance-metrics). For simple operations, the standard function node is more efficient.

### Native Backend Subsystem

The node uses Node.js worker_threads module by default, with additional optimizations:

- **Code Caching**: Each worker compiles the code once per unique code string and caches it (LRU cache with 100 entry limit). Subsequent executions reuse the compiled AsyncFunction.
- **Message Optimization**: Only `msg.*` properties referenced in your code are serialized and sent to workers (see [Message Handling](#message-handling)).
- **Buffer Transfer**: Worker threads transfer eligible Buffers without copying them. The Child Process runtime passes Buffers through filesystem-based shared memory.

### Processing Characteristics

- **Parallel Execution**: Multiple messages process simultaneously up to the worker count
- **Queue Management**: Messages exceeding worker capacity are queued (FIFO)
- **Auto-Recovery**: Crashed or timed-out workers are automatically replaced
- **Isolation**: Each worker runs in a separate V8 isolate with its own memory
- **No Blocking**: The code does not run on the Node-RED event loop. The main thread still copies the message to the worker and the result back, which takes time for very large objects
- **Memory Usage**: Each worker is a separate thread (or process) with its own memory, so memory use grows with the number of workers

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
| `totalMs` | Total wall-clock time from message receipt to the result being back in the main thread, time in the queue included |

Entries that other nodes wrote in `msg.performance` are kept.

## Shared Memory

### How Large Buffers Are Handled

Buffers travel differently in each runtime, in both directions (the message to the worker, the result back):

1. **Detection**: Buffer objects in the message are identified during serialization
2. **Transfer (Worker Threads)**: A Buffer that has its memory block to itself is transferred by ownership (zero-copy): the receiving side takes over the memory, and the Buffer left on the sending side is emptied (length 0). Any other Buffer is copied, with the limits described in [Buffers in Worker Threads](#buffers-in-worker-threads)
3. **Shared memory (Child Process)**: Every Buffer is written to a shared memory file
4. **Restoration**: The worker restores Buffers before executing your code
5. **Cleanup**: Shared memory files are automatically deleted after task completion

### Platform-Specific Behavior

Shared memory files are used by the Child Process runtime only.

| Platform | Shared Memory Path | Characteristics |
|----------|-------------------|-----------------|
| Linux | `/dev/shm` (`os.tmpdir()` when it is not writable) | RAM-backed tmpfs, zero disk I/O |
| macOS | `os.tmpdir()` | Disk-based, may involve I/O |
| Windows | `os.tmpdir()` | Disk-based, may involve I/O |

### File Naming Convention

Shared memory files follow this pattern:
```
rosepetal-async-{pid}-{taskId}-{bufferIndex}-{timestamp}-{random}.bin
```

### Cleanup and Orphan Detection

- **Normal cleanup**: Files are deleted as soon as they are read, and the files of a message when it finishes
- **Orphan detection**: When a node starts, files older than 1 hour matching the naming pattern are deleted
- **Fallback**: If shared memory write fails, buffers are base64-encoded (slower but reliable)

### Buffer Performance Tips

- Zero-copy transfer avoids file I/O for large Buffers in worker threads
- In worker threads, a Buffer made with `Buffer.alloc()` has its memory to itself and is transferred
- For best performance on Linux, ensure `/dev/shm` has sufficient space

## Limitations

### Not Available in Worker Code

| Feature | Reason | Alternative |
|---------|--------|-------------|
| `node.send()` | Node instance not available | Use `return` statement |
| `node.status()`, `node.done()`, `node.id` and the rest of `node` | `node` has only `warn`, `error` and `log` | None |
| `env.get()` | Environment helper not available | Access `process.env` directly |
| `RED` (`RED.util`) | Runtime not available | Use plain JavaScript or a module |

### Context + Node Helpers (Snapshot)

`context.get/set`, `flow.get/set`, and `global.get/set` are available with snapshot semantics. Reads come from the snapshot taken when the message arrives at the node, before it waits in the queue; writes are applied after your function completes, also when it throws an error, but not when it times out. The snapshot only includes literal keys detected in your code (e.g., `flow.get("count")`). Store-specific context selection is not supported (default store only). A value read with `get` is a copy: changing an object read this way does not change the stored one, so call `set` with it. `node.warn/error/log()` are collected and forwarded to the main thread when the function completes; `node.error()` reaches **catch** nodes with the incoming message.

Example:
```javascript
const count = flow.get('count') || 0;
flow.set('count', count + 1);
node.warn(`count=${count + 1}`);
```

### Serialization Requirements

The `msg` object is copied, not shared:
- **No functions**: Functions are dropped, they cannot be transferred between threads
- **No symbols**: Symbols are dropped
- **Circular references**: Kept
- **Class instances**: Converted to plain objects (prototype chain lost); a `Date` becomes `{}`, so send dates as strings or numbers

### Buffers in Worker Threads

These limits apply to the Worker Threads runtime only; the Child Process runtime passes every Buffer as a Buffer.

- A Buffer that shares its memory block with other Buffers, such as a small Buffer made with `Buffer.from()` or `Buffer.concat()`, or a slice of a larger Buffer, arrives on the other side as a plain object with one property per byte instead of a Buffer. This applies to the incoming message and to the result. To return such a Buffer, copy it into one of its own: `const out = Buffer.alloc(buf.length); buf.copy(out);`. For incoming messages that carry such Buffers, use the Child Process runtime.
- A Buffer that is transferred to the worker is emptied (length 0) in the main thread. The message sent takes the Buffers the code returns, so a code that reads a Buffer should return it (`return msg;`): when it returns a new object instead, the output keeps the emptied Buffer. A Buffer read with `flow.get()`, `global.get()` or `context.get()` goes to the worker the same way; when it is transferred and the context store is the default memory store, the Buffer kept in the store is emptied.

### Other Limitations

- **Overhead**: Every message is copied to a worker and back, not suitable for sub-millisecond operations
- **Memory usage**: Each worker has its own memory
- **Limited node access**: `node.warn/error/log()` are available, but other node methods are not
- **Snapshot context**: Context reads are from the snapshot; updates apply after execution
- **Console output**: `console.log()` writes to the output of the Node-RED process, not to the Debug sidebar; use `node.warn()` to see a value there

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

The code names only `msg.payload`, so only the payload goes to the worker: `msg.req` and `msg.res` stay in the main thread for the **http response** node (see [Message Handling](#message-handling)).

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

The **file in** node is set to output a single Buffer object.

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

**Issue**: The status shows `Init failed` and the log has `Failed to initialize worker pool: Worker failed to load module(s): <module> (<Import as>): Cannot find module …`.

**Cause**: The workers did not find the module in the `node_modules` folder of the Node-RED user directory: the installation failed, or the **Module** field has a version (`lodash@4.17.21`).

**Solution**:
- Check Node-RED console for installation errors
- Manually install the module: `cd ~/.node-red && npm install <module>`
- Verify the module name is spelled correctly
- For scoped packages, use the full name: `@scope/package`
- Then press **Restart Workers** in the Setup tab, or deploy the node again

### Properties Missing or Changed in the Worker

**Issue**: A `msg` property is `undefined` in the code, or arrives with a different value.

**Cause**: Only the properties the code names as `msg.<name>` are copied (see [Message Handling](#message-handling)); functions and symbols are dropped; class instances and dates become plain objects; in worker threads, small Buffers become plain objects (see [Buffers in Worker Threads](#buffers-in-worker-threads)).

**Solution**:
- Write each property the code reads as `msg.<name>` at least once
- Send dates as strings or numbers, and class instances as plain data
- Use the Child Process runtime for messages that carry small Buffers

### Worker Crash/Restart

**Issue**: Messages fail with `Worker error: …`, for example `Worker error: Worker exited with code 1`.

**Cause**: The worker ended while it was running the message (out of memory, a crash in a native module). The node replaces it with a new one. Errors thrown by the code do not end the worker: they fail the message instead (see [Status and Errors](#status-and-errors)).

**Solution**:
- Process large data in smaller pieces
- Try the Child Process runtime for native modules
- Use `console.log()` to follow what the code does before the crash: it writes to the output of the Node-RED process, while the `node.warn()` messages of a message are lost with its worker

### High Memory Usage

**Issue**: Node-RED process uses excessive memory.

**Cause**: Too many workers configured or memory leaks in user code.

**Solution**:
- Reduce the number of workers (each has its own memory)
- Check for memory leaks in your code (unreleased references, growing arrays)
- Monitor with `msg.performance` to identify slow operations
- Consider processing large datasets in smaller batches

### Status Shows Yellow/Red

**Issue**: Node status shows yellow or red indicator.

**Expected**: Green = normal, Yellow = queue > 50, Red = queue at 90% of Queue Size or more, a recent error, or a start failure (see [Status and Errors](#status-and-errors)).

**Solution**:
- Yellow: Queue is getting full - consider adding workers or upstream flow control
- Red: Queue almost full or recent error - check logs and consider scaling up
- Ring shape: All workers busy with backlog - increase workers or optimize code
