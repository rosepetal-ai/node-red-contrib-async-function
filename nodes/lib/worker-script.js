/**
 * Worker Thread Script
 *
 * Executes user-provided JavaScript code in an isolated worker thread.
 * Handles message communication with the main thread.
 */

const { parentPort, workerData } = require('worker_threads');

// Track worker state
let isTerminating = false;

/**
 * Execute user code safely
 *
 * @param {string} code - User function code
 * @param {object} msg - Message object
 * @returns {object|Array} Result or array of results for multiple outputs
 */
async function executeUserCode(code, msg) {
    // Create a function from the user code
    // The function receives 'msg' as parameter and can use return
    const AsyncFunction = (async function() {}).constructor;
    const userFunction = new AsyncFunction('msg', code);

    // Execute the function
    const result = await userFunction(msg);

    return result;
}

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
                // Execute user code
                const result = await executeUserCode(code, msg);

                // Send result back to main thread
                parentPort.postMessage({
                    type: 'result',
                    taskId,
                    result
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

    process.on('unhandledRejection', (reason, promise) => {
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
