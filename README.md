# node-red-contrib-async-function

Run heavy computations in Node-RED without slowing down your flows. This node works like the function node you already know, but keeps things responsive when the work gets heavy.

![Example](assets/example.png)

## What You Get

- Write JavaScript code that feels familiar—same as the function node.
- Run CPU-intensive tasks without blocking other flows.
- See real-time stats showing active workers and queue depth.
- Configure worker pools to match your workload.
- Handle bursts of messages smoothly with automatic queuing.

## Before You Start

- Node.js 18 or newer (worker threads need it).
- Node-RED 2.0 or newer.

## How It Works

Drop an **async function** node into your flow. Write your code just like you would in a regular function node. The difference? Your code runs in a separate worker thread, so heavy operations won't freeze Node-RED.

## When to Use This

**Great For:**
- Calculating prime numbers, running crypto operations, or processing large datasets.
- Tasks that take more than 10 milliseconds to finish.
- Keeping your dashboard and other flows responsive during heavy work.

**Skip It For:**
- Simple math or quick transformations (the regular function node is faster).
- When you need `context`, `flow`, or `global` storage (coming in v2.0).

## Node Options

### Code & Behavior
- **Name** – Optional label for your canvas.
- **Function** – Your JavaScript code. Works with `async/await`, `return`, and `require()`.
- **Outputs** – How many output wires (0-10). Return an array for multiple outputs.
- **Timeout** – Maximum seconds to wait before killing the worker. Default: 30 seconds.

### Worker Pool
- **Min Workers** – How many threads to keep ready at all times. Default: 2.
- **Max Workers** – Maximum threads to spin up when busy. Default: 4.
- **Queue Size** – Messages to queue when all workers are occupied. Default: 100.

## Typical Flow

1. Add an **async function** node to your workspace.
2. Connect an Inject node (input) and a Debug node (output).
3. Write a simple script:
   ```javascript
   msg.payload = msg.payload * 2;
   return msg;
   ```
4. Deploy and trigger. Watch the status update in real time.

## What You Can Use in Your Code

**Available:**
- `msg` – The message object (must be serializable)
- `return` – Return a single message or array of messages
- `async/await` – For asynchronous operations
- `require()` – Load Node.js built-in or installed modules
- `console` – Logging functions
- `setTimeout`, `setInterval` – Timers

**Not Available (Yet):**
- `context`, `flow`, `global` – Coming in v2.0
- `node` – Node instance methods
- Non-serializable objects (functions, symbols, etc.)

## Code Examples

### Simple Transformation
```javascript
msg.payload = msg.payload * 2;
return msg;
```

### Using External Modules
```javascript
const crypto = require('crypto');

msg.hash = crypto.createHash('sha256')
    .update(msg.payload)
    .digest('hex');

return msg;
```

### CPU-Intensive Task (Won't Block!)
```javascript
function isPrime(n) {
    if (n <= 1) return false;
    for (let i = 2; i * i <= n; i++) {
        if (n % i === 0) return false;
    }
    return true;
}

const limit = msg.payload;
const primes = [];

for (let i = 2; i <= limit; i++) {
    if (isPrime(i)) {
        primes.push(i);
    }
}

msg.payload = primes;
return msg;
```

### Multiple Outputs
```javascript
if (msg.payload > 100) {
    return [msg, null];  // Send to first output
} else {
    return [null, msg];  // Send to second output
}
```

## Status Display

The node shows you what's happening in real time:

- **Active: 2/4** – 2 workers processing out of 4 total
- **Queue: 5** – 5 messages waiting
- **Green dot** – Normal operation
- **Yellow dot** – Queue filling up (>50 messages)
- **Red dot** – Queue almost full (>90%) or error
- **Ring** – All workers busy with a backlog

## Performance Notes

- Worker threads add about 5-10ms overhead per message.
- Best for operations taking more than 10ms to run.
- Workers are pooled and reused—no startup delay after the first message.

## Error Handling

Errors in your code get caught and sent to a Catch node:

```javascript
if (!msg.payload) {
    throw new Error('Payload is required');
}
```

## Installation

```bash
cd ~/.node-red
npm install @rosepetal/node-red-contrib-async-function
```

Restart Node-RED and find the node in the **function** category.

## Contributing

Found a bug or have an idea? Open an issue or pull request on [GitHub](https://github.com/rosepetal-ai/node-red-contrib-async-function).

## License

Apache-2.0 © 2025 Rosepetal

---

**Built by [Rosepetal](https://www.rosepetal.ai)** – Making Node-RED flows faster and friendlier.
