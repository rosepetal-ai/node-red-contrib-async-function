/**
 * Worker Thread Script
 *
 * Executes user-provided JavaScript code in an isolated worker thread.
 * Handles message communication with the main thread.
 * Restores buffers from shared memory before execution.
 */

const { parentPort, workerData } = require('worker_threads');
const { AsyncLocalStorage } = require('async_hooks');
const { SharedMemoryManager } = require('./shared-memory-manager');
const { AsyncMessageSerializer } = require('./message-serializer');

// Track worker state
let isTerminating = false;

// AsyncLocalStorage for tracking task context across async boundaries
// This ensures unhandled rejections can be attributed to the correct task
const taskContext = new AsyncLocalStorage();

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
// Bounded LRU-style cache to prevent memory leaks with varied code inputs
const AsyncFunction = (async function() {}).constructor;
const MAX_CACHE_SIZE = 100;
const compiledCodeCache = new Map(); // code string -> AsyncFunction(msg, ...modules) { ... }

function getCachedFunction(cacheKey) {
    const fn = compiledCodeCache.get(cacheKey);
    if (fn) {
        // Move to end for LRU behavior (delete + re-add)
        compiledCodeCache.delete(cacheKey);
        compiledCodeCache.set(cacheKey, fn);
    }
    return fn;
}

function setCachedFunction(cacheKey, fn) {
    // Evict oldest entries if at capacity
    if (compiledCodeCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = compiledCodeCache.keys().next().value;
        compiledCodeCache.delete(oldestKey);
    }
    compiledCodeCache.set(cacheKey, fn);
}

// Load configured external modules
const loadedModules = {};
const moduleVars = [];
const moduleValues = [];
const failedModules = [];  // Track modules that failed to load

// Add Node-RED user directory to module search path for external modules
if (workerData && workerData.nodeRedUserDir) {
    const path = require('path');
    const nodeModulesPath = path.join(workerData.nodeRedUserDir, 'node_modules');
    if (!module.paths.includes(nodeModulesPath)) {
        module.paths.unshift(nodeModulesPath);
    }
}

if (workerData && workerData.libs && Array.isArray(workerData.libs)) {
    for (const lib of workerData.libs) {
        if (lib.module && lib.var) {
            try {
                loadedModules[lib.var] = require(lib.module);
                moduleVars.push(lib.var);
                moduleValues.push(loadedModules[lib.var]);
            } catch (err) {
                console.error(`[async-function] Failed to load module ${lib.module}: ${err.message}`);
                failedModules.push({ module: lib.module, var: lib.var, error: err.message });
            }
        }
    }
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
            // Run task within AsyncLocalStorage context for proper error attribution
            // This ensures unhandled rejections from fire-and-forget promises
            // can be traced back to the correct task
            taskContext.run({ taskId }, async () => {
                try {
                    // Restore + execute user code
                    const restoreStart = process.hrtime.bigint();
                    const restoredMsg = await serializer.restoreBuffers(msg);
                    const transferToPythonMs = hrtimeDiffToMs(restoreStart);

                    // Cache key includes code + module vars to handle different module configs
                    const cacheKey = code + '|' + moduleVars.join(',');
                    let userFunction = getCachedFunction(cacheKey);
                    if (!userFunction) {
                        // Create function with msg + all module variables as parameters
                        userFunction = new AsyncFunction('msg', ...moduleVars, code);
                        setCachedFunction(cacheKey, userFunction);
                    }

                    const execStart = process.hrtime.bigint();
                    // Execute with msg and all loaded module values
                    const rawResult = await userFunction(restoredMsg, ...moduleValues);
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
            });
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

    // Handle errors - use AsyncLocalStorage to get taskId for proper error attribution
    process.on('uncaughtException', (err) => {
        if (!isTerminating) {
            const store = taskContext.getStore();
            parentPort.postMessage({
                type: 'error',
                taskId: store?.taskId ?? null,
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
            const store = taskContext.getStore();
            parentPort.postMessage({
                type: 'error',
                taskId: store?.taskId ?? null,
                error: {
                    message: `Unhandled rejection: ${reason}`,
                    stack: reason?.stack || '',
                    name: 'UnhandledRejection'
                }
            });
        }
    });

    // Signal ready (include any module loading failures)
    parentPort.postMessage({
        type: 'ready',
        failedModules: failedModules.length > 0 ? failedModules : undefined
    });
}
