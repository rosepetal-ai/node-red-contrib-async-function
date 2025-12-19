/**
 * Worker Thread Script
 *
 * Executes user-provided JavaScript code in an isolated worker thread.
 * Handles message communication with the main thread.
 * Restores buffers from shared memory before execution.
 */

const { parentPort, workerData } = require('worker_threads');
const { SharedMemoryManager } = require('./shared-memory-manager');
const { AsyncMessageSerializer } = require('./message-serializer');

// Track worker state
let isTerminating = false;

function hrtimeDiffToMs(start) {
    if (typeof start !== 'bigint') {
        return 0;
    }
    const diff = process.hrtime.bigint() - start;
    return Number(diff) / 1e6;
}

// Shared memory management (for buffer restoration + result encoding)
const shmManager = new SharedMemoryManager({
    threshold: workerData && typeof workerData.shmThreshold === 'number' ? workerData.shmThreshold : undefined,
    trackAttachments: false,
    cleanupOrphanedFiles: false
});
const serializer = new AsyncMessageSerializer(shmManager);

// Cache compiled user code per worker for hot-path performance
const AsyncFunction = (async function() {}).constructor;
const compiledCodeCache = new Map(); // code string -> AsyncFunction(msg) { ... }

/**
 * Handle incoming messages from main thread
 */
if (parentPort) {
    parentPort.on('message', async (data) => {
        // Ignore messages if terminating
        if (isTerminating) {
            return;
        }

        const { type, taskId, code, msg } = data;

        // Handle different message types
        if (type === 'execute') {
            try {
                // Restore + execute user code
                const restoreStart = process.hrtime.bigint();
                const restoredMsg = await serializer.restoreBuffers(msg);
                const transferToPythonMs = hrtimeDiffToMs(restoreStart);

                let userFunction = compiledCodeCache.get(code);
                if (!userFunction) {
                    userFunction = new AsyncFunction('msg', code);
                    compiledCodeCache.set(code, userFunction);
                }

                const execStart = process.hrtime.bigint();
                const rawResult = await userFunction(restoredMsg);
                const executionMs = hrtimeDiffToMs(execStart);

                // Offload buffers in the result (large Buffers -> shared memory descriptors)
                const encodeStart = process.hrtime.bigint();
                const encodedResult = await serializer.sanitizeMessage(rawResult, null, taskId);
                const transferToJsMs = hrtimeDiffToMs(encodeStart);

                // Send result back to main thread
                parentPort.postMessage({
                    type: 'result',
                    taskId,
                    result: encodedResult,
                    performance: {
                        transfer_to_python_ms: transferToPythonMs,
                        execution_ms: executionMs,
                        transfer_to_js_ms: transferToJsMs
                    }
                });

            } catch (err) {
                // Send error back to main thread
                parentPort.postMessage({
                    type: 'error',
                    taskId,
                    error: {
                        message: err.message,
                        stack: err.stack,
                        name: err.name
                    }
                });
            }
        } else if (type === 'terminate') {
            // Graceful termination requested
            isTerminating = true;
            parentPort.postMessage({
                type: 'terminated',
                taskId
            });
            process.exit(0);
        }
    });

    // Handle errors
    process.on('uncaughtException', (err) => {
        if (!isTerminating) {
            parentPort.postMessage({
                type: 'error',
                taskId: null,
                error: {
                    message: `Uncaught exception: ${err.message}`,
                    stack: err.stack,
                    name: err.name
                }
            });
        }
    });

    process.on('unhandledRejection', (reason, _promise) => {
        if (!isTerminating) {
            parentPort.postMessage({
                type: 'error',
                taskId: null,
                error: {
                    message: `Unhandled rejection: ${reason}`,
                    stack: reason?.stack || '',
                    name: 'UnhandledRejection'
                }
            });
        }
    });

    // Signal ready
    parentPort.postMessage({
        type: 'ready'
    });
}
