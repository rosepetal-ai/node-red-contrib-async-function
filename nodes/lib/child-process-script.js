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
            try {
                const restoreStart = process.hrtime.bigint();
                const restoredMsg = await serializer.restoreBuffers(msg);
                const transferToWorkerMs = hrtimeDiffToMs(restoreStart);

                const cacheKey = code + '|' + moduleVars.join(',');
                let userFunction = getCachedFunction(cacheKey);
                if (!userFunction) {
                    userFunction = new AsyncFunction('msg', ...moduleVars, code);
                    setCachedFunction(cacheKey, userFunction);
                }

                const execStart = process.hrtime.bigint();
                const rawResult = await userFunction(restoredMsg, ...moduleValues);
                const executionMs = hrtimeDiffToMs(execStart);

                const encodeStart = process.hrtime.bigint();
                const encodedResult = await serializer.sanitizeMessage(rawResult, null, taskId, {
                    transferMode
                });
                const transferToMainMs = hrtimeDiffToMs(encodeStart);

                sendMessage({
                    type: 'result',
                    taskId,
                    result: encodedResult,
                    performance: {
                        transferToWorkerMs,
                        executionMs,
                        transferToMainMs
                    }
                });
            } catch (err) {
                sendError(taskId, err);
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
