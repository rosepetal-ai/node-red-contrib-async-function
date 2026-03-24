/**
 * Worker Thread Script
 *
 * Executes user-provided JavaScript code in an isolated worker thread.
 * Handles message communication with the main thread.
 * Restores buffers from shared memory before execution.
 */

const { parentPort, workerData } = require('worker_threads');
const { AsyncLocalStorage } = require('async_hooks');
const { createRequire, builtinModules } = require('module');
const path = require('path');
const url = require('url');
const { SharedMemoryManager } = require('./shared-memory-manager');
const { AsyncMessageSerializer } = require('./message-serializer');

// Track worker state
let isTerminating = false;
const transferMode = workerData && typeof workerData.transferMode === 'string' ? workerData.transferMode : 'transfer';
const MSG_WRAPPER_KEY = '__rosepetal_msg';
const CONTEXT_WRAPPER_KEY = '__rosepetal_context';

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

const baseRequire = (() => {
    if (workerData && workerData.nodeRedUserDir) {
        return createRequire(path.join(workerData.nodeRedUserDir, 'package.json'));
    }
    return require;
})();

global.require = baseRequire;

function createContextProxy(initialData, updates) {
    const data = (initialData && typeof initialData === 'object') ? initialData : {};
    const updateMap = updates || {};

    const getValue = (key, fallback) => {
        if (Object.prototype.hasOwnProperty.call(updateMap, key)) {
            return updateMap[key];
        }
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            return data[key];
        }
        return fallback;
    };

    const setValue = (key, value) => {
        data[key] = value;
        updateMap[key] = value;
    };

    const api = {
        get: (key, storeOrCb, cbMaybe) => {
            let callback = null;
            if (typeof storeOrCb === 'function') {
                callback = storeOrCb;
            } else if (typeof cbMaybe === 'function') {
                callback = cbMaybe;
            }

            const value = Array.isArray(key)
                ? key.map((entry) => getValue(entry, undefined))
                : getValue(key, undefined);

            if (typeof callback === 'function') {
                callback(null, value);
                return undefined;
            }
            return value;
        },
        set: (key, value, cbMaybe) => {
            let callback = typeof cbMaybe === 'function' ? cbMaybe : null;
            let entries = [];

            if (Array.isArray(key)) {
                if (Array.isArray(value)) {
                    entries = key.map((entry, index) => [entry, value[index]]);
                } else if (value && typeof value === 'object') {
                    entries = key.map((entry) => [entry, value[entry]]);
                }
            } else if (key && typeof key === 'object' && value !== null) {
                entries = Object.entries(key);
                if (typeof value === 'function') {
                    callback = value;
                }
            } else {
                entries = [[key, value]];
            }

            entries.forEach(([entryKey, entryValue]) => {
                if (entryKey !== undefined) {
                    setValue(entryKey, entryValue);
                }
            });

            if (typeof callback === 'function') {
                callback(null);
            }
            return undefined;
        }
    };

    return new Proxy(api, {
        get(target, prop) {
            if (typeof prop === 'symbol' || prop in target) {
                return target[prop];
            }
            return getValue(prop, undefined);
        },
        set(target, prop, value) {
            if (typeof prop === 'symbol' || prop in target) {
                target[prop] = value;
                return true;
            }
            setValue(prop, value);
            return true;
        }
    });
}

function createNodeProxy(logs) {
    const push = (level, args) => {
        if (!Array.isArray(logs)) {
            return;
        }
        if (!args || args.length === 0) {
            logs.push({ level, message: '' });
            return;
        }
        const message = args.length === 1 ? args[0] : args.map((arg) => arg);
        logs.push({ level, message });
    };

    return {
        warn: (...args) => {
            push('warn', args);
        },
        error: (...args) => {
            push('error', args);
        },
        log: (...args) => {
            push('log', args);
        }
    };
}

function parseModuleSpec(spec) {
    const match = /((?:@[^/]+\/)?[^/@]+)(\/[^/@]+)?(?:@([\s\S]+))?/.exec(spec);
    if (!match) {
        return { spec, module: spec, subpath: '', builtin: false };
    }
    const moduleName = match[1];
    const subpath = match[2] || '';
    let builtinName = moduleName;
    if (builtinName.startsWith('node:')) {
        builtinName = builtinName.slice(5);
    }
    const builtin = builtinModules.includes(builtinName);
    return { spec, module: moduleName, subpath, builtin };
}

async function loadModule(spec) {
    const parsed = parseModuleSpec(spec);
    if (parsed.builtin) {
        return baseRequire(parsed.module + parsed.subpath);
    }
    const resolvedPath = baseRequire.resolve(spec);
    const moduleUrl = url.pathToFileURL(resolvedPath);
    const imported = await import(moduleUrl);
    return imported.default || imported;
}

async function loadConfiguredModules() {
    if (!workerData || !Array.isArray(workerData.libs)) {
        return;
    }
    for (const lib of workerData.libs) {
        if (!lib || !lib.module || !lib.var) {
            continue;
        }
        try {
            loadedModules[lib.var] = await loadModule(lib.module);
            moduleVars.push(lib.var);
            moduleValues.push(loadedModules[lib.var]);
        } catch (err) {
            console.error(`[worker-function] Failed to load module ${lib.module}: ${err.message}`);
            failedModules.push({ module: lib.module, var: lib.var, error: err.message });
        }
    }
}

/**
 * Handle incoming messages from main thread
 */
async function initializeWorker() {
    await loadConfiguredModules();

    if (!parentPort) {
        return;
    }

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
                const contextUpdates = { flow: {}, global: {}, context: {} };
                const logs = [];

                try {
                    // Restore + execute user code
                    const restoreStart = process.hrtime.bigint();
                    const restoredPayload = await serializer.restoreBuffers(msg);
                    const transferToWorkerMs = hrtimeDiffToMs(restoreStart);

                    let contextPayload = {};
                    let restoredMsg = restoredPayload;
                    if (restoredPayload && typeof restoredPayload === 'object' && Object.prototype.hasOwnProperty.call(restoredPayload, MSG_WRAPPER_KEY)) {
                        contextPayload = restoredPayload[CONTEXT_WRAPPER_KEY] || {};
                        restoredMsg = restoredPayload[MSG_WRAPPER_KEY];
                    }

                    const nodeProxy = createNodeProxy(logs);
                    const flowProxy = createContextProxy(contextPayload.flow, contextUpdates.flow);
                    const globalProxy = createContextProxy(contextPayload.global, contextUpdates.global);
                    const contextProxy = createContextProxy(contextPayload.context, contextUpdates.context);

                    // Cache key includes code + module vars to handle different module configs
                    const cacheKey = code + '|' + moduleVars.join(',');
                    let userFunction = getCachedFunction(cacheKey);
                    if (!userFunction) {
                        // Create function with msg + all module variables as parameters
                        userFunction = new AsyncFunction('msg', 'node', 'flow', 'global', 'context', ...moduleVars, code);
                        setCachedFunction(cacheKey, userFunction);
                    }

                    const execStart = process.hrtime.bigint();
                    // Execute with msg and all loaded module values
                    const rawResult = await userFunction(restoredMsg, nodeProxy, flowProxy, globalProxy, contextProxy, ...moduleValues);
                    const executionMs = hrtimeDiffToMs(execStart);

                    // Offload buffers in result + context updates
                    const encodeStart = process.hrtime.bigint();
                    const transferList = transferMode === 'transfer' ? [] : null;
                    const transferSet = transferList ? new Set() : null;
                    const bufferCache = new WeakMap();

                    const encodedResult = await serializer.sanitizeMessage(rawResult, null, taskId, {
                        transferMode,
                        transferList,
                        transferSet,
                        bufferCache
                    });

                    const hasUpdates = (
                        Object.keys(contextUpdates.flow).length > 0 ||
                        Object.keys(contextUpdates.global).length > 0 ||
                        Object.keys(contextUpdates.context).length > 0
                    );

                    const encodedContextUpdates = hasUpdates
                        ? await serializer.sanitizeMessage(contextUpdates, null, taskId, {
                            transferMode,
                            transferList,
                            transferSet,
                            bufferCache
                        })
                        : null;

                    const transferToMainMs = hrtimeDiffToMs(encodeStart);

                    // Send result back to main thread
                    const payload = {
                        type: 'result',
                        taskId,
                        result: encodedResult,
                        contextUpdates: encodedContextUpdates,
                        logs: logs.length > 0 ? logs : null,
                        performance: {
                            transferToWorkerMs,
                            executionMs,
                            transferToMainMs
                        }
                    };

                    if (transferList && transferList.length > 0) {
                        parentPort.postMessage(payload, transferList);
                    } else {
                        parentPort.postMessage(payload);
                    }

                } catch (err) {
                    // Send error back to main thread
                    const transferList = transferMode === 'transfer' ? [] : null;
                    const transferSet = transferList ? new Set() : null;
                    const bufferCache = new WeakMap();
                    const hasUpdates = (
                        Object.keys(contextUpdates.flow).length > 0 ||
                        Object.keys(contextUpdates.global).length > 0 ||
                        Object.keys(contextUpdates.context).length > 0
                    );

                    let encodedContextUpdates = null;
                    if (hasUpdates) {
                        try {
                            encodedContextUpdates = await serializer.sanitizeMessage(contextUpdates, null, taskId, {
                                transferMode,
                                transferList,
                                transferSet,
                                bufferCache
                            });
                        } catch (_encodeErr) {
                            encodedContextUpdates = null;
                        }
                    }

                    const payload = {
                        type: 'error',
                        taskId,
                        error: {
                            message: err.message,
                            stack: err.stack,
                            name: err.name
                        },
                        contextUpdates: encodedContextUpdates,
                        logs: logs.length > 0 ? logs : null
                    };

                    if (transferList && transferList.length > 0) {
                        parentPort.postMessage(payload, transferList);
                    } else {
                        parentPort.postMessage(payload);
                    }
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

initializeWorker().catch((err) => {
    if (parentPort) {
        parentPort.postMessage({
            type: 'ready',
            failedModules: [{ module: '(init)', var: null, error: err.message }]
        });
    }
});
