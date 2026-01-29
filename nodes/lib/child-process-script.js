/**
 * Child Process Script
 *
 * Executes user-provided JavaScript code in a child process.
 * Handles message communication with the parent process.
 * Restores buffers from shared memory before execution.
 */

const { AsyncLocalStorage } = require('async_hooks');
const { createRequire, builtinModules } = require('module');
const path = require('path');
const url = require('url');
const { SharedMemoryManager } = require('./shared-memory-manager');
const { AsyncMessageSerializer } = require('./message-serializer');

// Track worker state
let isTerminating = false;
let isInitialized = false;
let transferMode = 'shared';
const MSG_WRAPPER_KEY = '__rosepetal_msg';
const CONTEXT_WRAPPER_KEY = '__rosepetal_context';

// AsyncLocalStorage for tracking task context across async boundaries
const taskContext = new AsyncLocalStorage();

function hrtimeDiffToMs(start) {
    if (typeof start !== 'bigint') {
        return 0;
    }
    const diff = process.hrtime.bigint() - start;
    return Number(diff) / 1e6;
}

// Shared memory manager and serializer are initialized after init message
let shmManager = null;
let serializer = null;

// Cache compiled user code per worker for hot-path performance
const AsyncFunction = (async function() {}).constructor;
const MAX_CACHE_SIZE = 100;
const compiledCodeCache = new Map();

function getCachedFunction(cacheKey) {
    const fn = compiledCodeCache.get(cacheKey);
    if (fn) {
        compiledCodeCache.delete(cacheKey);
        compiledCodeCache.set(cacheKey, fn);
    }
    return fn;
}

function setCachedFunction(cacheKey, fn) {
    if (compiledCodeCache.size >= MAX_CACHE_SIZE) {
        const oldestKey = compiledCodeCache.keys().next().value;
        compiledCodeCache.delete(oldestKey);
    }
    compiledCodeCache.set(cacheKey, fn);
}

// Module loading setup
let baseRequire = require;
const loadedModules = {};
const moduleVars = [];
const moduleValues = [];
const failedModules = [];

function configureBaseRequire(nodeRedUserDir) {
    if (nodeRedUserDir) {
        baseRequire = createRequire(path.join(nodeRedUserDir, 'package.json'));
    } else {
        baseRequire = require;
    }
    global.require = baseRequire;
}

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

async function loadConfiguredModules(libs) {
    if (!Array.isArray(libs)) {
        return;
    }
    for (const lib of libs) {
        if (!lib || !lib.module || !lib.var) {
            continue;
        }
        try {
            loadedModules[lib.var] = await loadModule(lib.module);
            moduleVars.push(lib.var);
            moduleValues.push(loadedModules[lib.var]);
        } catch (err) {
            console.error(`[async-function] Failed to load module ${lib.module}: ${err.message}`);
            failedModules.push({ module: lib.module, var: lib.var, error: err.message });
        }
    }
}

function sendMessage(payload) {
    if (typeof process.send === 'function') {
        process.send(payload);
    }
}

function sendError(taskId, err) {
    const error = err instanceof Error ? err : new Error(String(err));
    sendMessage({
        type: 'error',
        taskId,
        error: {
            message: error.message,
            stack: error.stack || '',
            name: error.name || 'Error'
        }
    });
}

async function initializeWorker(initData) {
    const nodeRedUserDir = initData && initData.nodeRedUserDir ? initData.nodeRedUserDir : null;
    configureBaseRequire(nodeRedUserDir);

    const threshold = initData && typeof initData.shmThreshold === 'number' ? initData.shmThreshold : undefined;
    if (initData && typeof initData.transferMode === 'string') {
        transferMode = initData.transferMode;
    }
    shmManager = new SharedMemoryManager({
        threshold,
        trackAttachments: false,
        cleanupOrphanedFiles: false
    });
    serializer = new AsyncMessageSerializer(shmManager);

    await loadConfiguredModules(initData ? initData.libs : []);
    isInitialized = true;

    sendMessage({
        type: 'ready',
        failedModules: failedModules.length > 0 ? failedModules : undefined
    });
}

process.on('message', async (data) => {
    if (!data || typeof data !== 'object') {
        return;
    }

    if (data.type === 'init') {
        try {
            await initializeWorker(data);
        } catch (err) {
            failedModules.push({ module: '(init)', var: null, error: err.message });
            sendMessage({
                type: 'ready',
                failedModules
            });
        }
        return;
    }

    if (isTerminating) {
        return;
    }

    if (!isInitialized) {
        if (data.type === 'execute') {
            sendError(data.taskId, new Error('Worker not initialized'));
        }
        return;
    }

    const { type, taskId, code, msg } = data;

    if (type === 'execute') {
        taskContext.run({ taskId }, async () => {
            const contextUpdates = { flow: {}, global: {}, context: {} };
            const logs = [];

            try {
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

                const cacheKey = code + '|' + moduleVars.join(',');
                let userFunction = getCachedFunction(cacheKey);
                if (!userFunction) {
                    userFunction = new AsyncFunction('msg', 'node', 'flow', 'global', 'context', ...moduleVars, code);
                    setCachedFunction(cacheKey, userFunction);
                }

                const execStart = process.hrtime.bigint();
                const rawResult = await userFunction(restoredMsg, nodeProxy, flowProxy, globalProxy, contextProxy, ...moduleValues);
                const executionMs = hrtimeDiffToMs(execStart);

                const encodeStart = process.hrtime.bigint();
                const bufferCache = new WeakMap();
                const encodedResult = await serializer.sanitizeMessage(rawResult, null, taskId, {
                    transferMode,
                    bufferCache
                });
                const hasUpdates = (
                    Object.keys(contextUpdates.flow).length > 0 ||
                    Object.keys(contextUpdates.global).length > 0 ||
                    Object.keys(contextUpdates.context).length > 0
                );
                const encodedContextUpdates = hasUpdates
                    ? await serializer.sanitizeMessage(contextUpdates, null, taskId, { transferMode, bufferCache })
                    : null;
                const transferToMainMs = hrtimeDiffToMs(encodeStart);

                sendMessage({
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
                });
            } catch (err) {
                let encodedContextUpdates = null;
                const hasUpdates = (
                    Object.keys(contextUpdates.flow).length > 0 ||
                    Object.keys(contextUpdates.global).length > 0 ||
                    Object.keys(contextUpdates.context).length > 0
                );
                if (hasUpdates) {
                    try {
                        encodedContextUpdates = await serializer.sanitizeMessage(contextUpdates, null, taskId, { transferMode });
                    } catch (_encodeErr) {
                        encodedContextUpdates = null;
                    }
                }

                const error = err instanceof Error ? err : new Error(String(err));
                sendMessage({
                    type: 'error',
                    taskId,
                    error: {
                        message: error.message,
                        stack: error.stack || '',
                        name: error.name || 'Error'
                    },
                    contextUpdates: encodedContextUpdates,
                    logs: logs.length > 0 ? logs : null
                });
            }
        });
    } else if (type === 'terminate') {
        isTerminating = true;
        sendMessage({
            type: 'terminated',
            taskId
        });
        process.exit(0);
    }
});

process.on('uncaughtException', (err) => {
    if (!isTerminating) {
        const store = taskContext.getStore();
        sendMessage({
            type: 'error',
            taskId: store?.taskId ?? null,
            error: {
                message: `Uncaught exception: ${err.message}`,
                stack: err.stack || '',
                name: err.name || 'Error'
            }
        });
    }
});

process.on('unhandledRejection', (reason) => {
    if (!isTerminating) {
        const store = taskContext.getStore();
        const error = reason instanceof Error ? reason : new Error(String(reason));
        sendMessage({
            type: 'error',
            taskId: store?.taskId ?? null,
            error: {
                message: `Unhandled rejection: ${error.message}`,
                stack: error.stack || '',
                name: 'UnhandledRejection'
            }
        });
    }
});
