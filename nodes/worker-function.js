/**
 * Worker Function Node
 *
 * A Node-RED function node that executes user code in worker threads
 * or child processes to prevent event loop blocking.
 */

const path = require('path');
const { WorkerPool } = require('./lib/worker-pool');
const { ChildProcessPool } = require('./lib/child-process-pool');

function resolveNodeRedUserDir(RED) {
    if (RED && RED.settings && RED.settings.userDir) {
        return path.resolve(RED.settings.userDir);
    }
    if (process.env.NODE_RED_HOME) {
        return path.resolve(process.env.NODE_RED_HOME);
    }
    return process.cwd();
}

function extractMsgKeysFromCode(code) {
    const keys = new Set();
    if (typeof code !== 'string' || !code.trim()) {
        return keys;
    }

    // msg['payload'] or msg["payload"]
    const bracketRegex = /msg\[['"]([A-Za-z0-9_.$:-]+)['"]\]/g;
    let match = bracketRegex.exec(code);
    while (match) {
        keys.add(match[1]);
        match = bracketRegex.exec(code);
    }

    // msg.payload style access
    const dotRegex = /msg\.([A-Za-z_][A-Za-z0-9_]*)/g;
    match = dotRegex.exec(code);
    while (match) {
        keys.add(match[1]);
        match = dotRegex.exec(code);
    }

    return keys;
}

function buildWorkerInputMsgCore(originalMsg, code) {
    if (!originalMsg || typeof originalMsg !== 'object') {
        return originalMsg;
    }

    const keys = extractMsgKeysFromCode(code);

    // If we cannot confidently determine keys, fall back to full message
    if (!keys || keys.size === 0) {
        return originalMsg;
    }

    const subset = {};
    keys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(originalMsg, key)) {
            subset[key] = originalMsg[key];
        }
    });

    // Preserve _msgid for traceability
    if (Object.prototype.hasOwnProperty.call(originalMsg, '_msgid') && !Object.prototype.hasOwnProperty.call(subset, '_msgid')) {
        subset._msgid = originalMsg._msgid;
    }

    return subset;
}

function normalizePerformanceValue(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function hrtimeDiffToMs(start) {
    if (typeof start !== 'bigint') {
        return 0;
    }
    const diff = process.hrtime.bigint() - start;
    return Number(diff) / 1e6;
}

function normalizeTransferMode(mode, executionMode) {
    const normalized = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
    if (normalized === 'transfer' || normalized === 'shared' || normalized === 'copy') {
        return normalized;
    }
    return executionMode === 'worker_threads' ? 'transfer' : 'shared';
}

const MSG_WRAPPER_KEY = '__rosepetal_msg';
const CONTEXT_WRAPPER_KEY = '__rosepetal_context';

function extractContextKeysFromCode(code) {
    const flowKeys = new Set();
    const globalKeys = new Set();
    const contextKeys = new Set();

    if (typeof code !== 'string' || !code.trim()) {
        return { flow: flowKeys, global: globalKeys, context: contextKeys, usesContext: false };
    }

    const flowRegex = /flow\.(?:get|set)\(\s*['"]([^'"]+)['"]/g;
    const flowBracket = /flow\[['"]([^'"]+)['"]\]/g;
    const globalRegex = /global\.(?:get|set)\(\s*['"]([^'"]+)['"]/g;
    const globalBracket = /global\[['"]([^'"]+)['"]\]/g;
    const contextRegex = /context\.(?:get|set)\(\s*['"]([^'"]+)['"]/g;
    const contextBracket = /context\[['"]([^'"]+)['"]\]/g;

    let match = flowRegex.exec(code);
    while (match) {
        flowKeys.add(match[1]);
        match = flowRegex.exec(code);
    }

    match = flowBracket.exec(code);
    while (match) {
        flowKeys.add(match[1]);
        match = flowBracket.exec(code);
    }

    match = globalRegex.exec(code);
    while (match) {
        globalKeys.add(match[1]);
        match = globalRegex.exec(code);
    }

    match = globalBracket.exec(code);
    while (match) {
        globalKeys.add(match[1]);
        match = globalBracket.exec(code);
    }

    match = contextRegex.exec(code);
    while (match) {
        contextKeys.add(match[1]);
        match = contextRegex.exec(code);
    }

    match = contextBracket.exec(code);
    while (match) {
        contextKeys.add(match[1]);
        match = contextBracket.exec(code);
    }

    const usesContext = /\b(flow|global|context)\s*\./.test(code);
    return { flow: flowKeys, global: globalKeys, context: contextKeys, usesContext };
}

async function buildContextSnapshot(node, code) {
    const empty = { flow: {}, global: {}, context: {} };
    if (!node || typeof node.context !== 'function') {
        return { snapshot: empty, usesContext: false };
    }

    const keys = extractContextKeysFromCode(code);
    if (!keys.usesContext) {
        return { snapshot: empty, usesContext: false };
    }

    const ctx = node.context();
    if (!ctx) {
        return { snapshot: empty, usesContext: true };
    }

    const snapshot = { flow: {}, global: {}, context: {} };
    const coerceBufferLike = (value) => {
        if (!value || typeof value !== 'object') {
            return value;
        }
        if (Buffer.isBuffer(value)) {
            return value;
        }
        if (value.type === 'Buffer' && Array.isArray(value.data)) {
            return Buffer.from(value.data);
        }
        if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
            return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        }
        return value;
    };

    const getValueAsync = (scope, key) => {
        if (!scope || typeof scope.get !== 'function') {
            return Promise.resolve(undefined);
        }
        if (scope.get.length >= 2) {
            return new Promise((resolve) => {
                try {
                    scope.get(key, (err, value) => {
                        resolve(err ? undefined : value);
                    });
                } catch (_err) {
                    resolve(undefined);
                }
            });
        }
        try {
            const value = scope.get(key);
            if (value && typeof value.then === 'function') {
                return value.then((resolved) => resolved).catch(() => undefined);
            }
            return Promise.resolve(value);
        } catch (_err) {
            return Promise.resolve(undefined);
        }
    };

    const readKeys = async (scope, keySet, target) => {
        if (!scope || typeof scope.get !== 'function') {
            return;
        }
        const entries = Array.from(keySet);
        await Promise.all(entries.map(async (key) => {
            try {
                const value = await getValueAsync(scope, key);
                target[key] = coerceBufferLike(value);
            } catch (_err) {
                // Ignore context read errors to avoid blocking execution
            }
        }));
    };

    await Promise.all([
        readKeys(ctx.flow, keys.flow, snapshot.flow),
        readKeys(ctx.global, keys.global, snapshot.global),
        readKeys(ctx, keys.context, snapshot.context)
    ]);

    return { snapshot, usesContext: true };
}

function buildWorkerInputMsg(originalMsg, code, contextSnapshot, useContextWrapper) {
    if (!useContextWrapper) {
        return buildWorkerInputMsgCore(originalMsg, code);
    }

    const msgPayload = buildWorkerInputMsgCore(originalMsg, code);
    return {
        [MSG_WRAPPER_KEY]: msgPayload,
        [CONTEXT_WRAPPER_KEY]: contextSnapshot || { flow: {}, global: {}, context: {} }
    };
}

function rehydrateContextValue(value) {
    if (Buffer.isBuffer(value)) {
        return value;
    }

    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }

    if (Array.isArray(value)) {
        return value.map((item) => rehydrateContextValue(item));
    }

    if (value && typeof value === 'object') {
        if (value.type === 'Buffer' && Array.isArray(value.data)) {
            return Buffer.from(value.data);
        }

        const obj = Array.isArray(value) ? [] : {};
        Object.keys(value).forEach((key) => {
            obj[key] = rehydrateContextValue(value[key]);
        });
        return obj;
    }

    return value;
}

async function applyContextUpdates(node, updates, msg) {
    if (!node || !updates || typeof updates !== 'object' || typeof node.context !== 'function') {
        return;
    }

    const context = node.context();
    if (!context) {
        return;
    }

    const flowUpdates = updates.flow && typeof updates.flow === 'object' ? updates.flow : {};
    const globalUpdates = updates.global && typeof updates.global === 'object' ? updates.global : {};
    const contextUpdates = updates.context && typeof updates.context === 'object' ? updates.context : {};

    const applyUpdates = async (scope, scopeLabel, scopeUpdates) => {
        if (!scope || typeof scope.set !== 'function') {
            return;
        }
        const setValueAsync = (key, value) => {
            if (scope.set.length >= 3) {
                return new Promise((resolve) => {
                    try {
                        scope.set(key, value, (err) => {
                            if (err && typeof node.warn === 'function') {
                                node.warn(`Failed to set ${scopeLabel} context "${key}": ${err.message || err}`, msg);
                            }
                            resolve();
                        });
                    } catch (err) {
                        if (typeof node.warn === 'function') {
                            node.warn(`Failed to set ${scopeLabel} context "${key}": ${err.message || err}`, msg);
                        }
                        resolve();
                    }
                });
            }
            try {
                const result = scope.set(key, value);
                if (result && typeof result.then === 'function') {
                    return result.catch((err) => {
                        if (typeof node.warn === 'function') {
                            node.warn(`Failed to set ${scopeLabel} context "${key}": ${err.message || err}`, msg);
                        }
                    });
                }
            } catch (err) {
                if (typeof node.warn === 'function') {
                    node.warn(`Failed to set ${scopeLabel} context "${key}": ${err.message || err}`, msg);
                }
            }
            return Promise.resolve();
        };
        const entries = Object.keys(scopeUpdates);
        await Promise.all(entries.map(async (key) => {
            const value = rehydrateContextValue(scopeUpdates[key]);
            await setValueAsync(key, value);
        }));
    };

    await Promise.all([
        applyUpdates(context.flow, 'flow', flowUpdates),
        applyUpdates(context.global, 'global', globalUpdates),
        applyUpdates(context, 'context', contextUpdates)
    ]);
}

function applyWorkerLogs(node, logs, msg) {
    if (!node || !Array.isArray(logs)) {
        return;
    }

    logs.forEach((entry) => {
        if (!entry) {
            return;
        }

        const level = typeof entry === 'object' && entry.level ? String(entry.level) : 'warn';
        const message = typeof entry === 'object' && entry.message !== undefined
            ? entry.message
            : entry;
        let text = '';
        if (typeof message === 'string') {
            text = message;
        } else {
            try {
                text = JSON.stringify(message);
            } catch (_err) {
                text = String(message);
            }
        }

        if (level === 'error' && typeof node.error === 'function') {
            node.error(text, msg);
            return;
        }

        if (level === 'log' && typeof node.log === 'function') {
            node.log(text);
            return;
        }

        if (typeof node.warn === 'function') {
            node.warn(text, msg);
        }
    });
}


function applyPerformanceMetrics(node, originalMsg, targetMsg, performance) {
    if (!performance || typeof performance !== 'object') {
        return;
    }

    const label = (typeof node.name === 'string' && node.name.trim()) ? node.name.trim() : 'worker function';
    if (!label) {
        return;
    }

    const copyPerformance = (source, destination) => {
        if (source && typeof source === 'object' && !Array.isArray(source)) {
            Object.keys(source).forEach((key) => {
                destination[key] = source[key];
            });
        }
    };

    const collected = {};
    if (originalMsg && originalMsg !== targetMsg) {
        copyPerformance(originalMsg.performance, collected);
    }
    copyPerformance(targetMsg.performance, collected);

    const transferToWorkerMs = normalizePerformanceValue(
        performance.transferToWorkerMs ??
        performance.transfer_to_worker_ms ??
        performance.transferToPythonMs ??
        performance.transfer_to_python_ms
    );
    const executionMs = normalizePerformanceValue(
        performance.executionMs ?? performance.execution_ms
    );
    const transferToMainMs = normalizePerformanceValue(
        performance.transferToMainMs ??
        performance.transfer_to_main_ms ??
        performance.transferToJsMs ??
        performance.transfer_to_js_ms
    );
    const totalMs = normalizePerformanceValue(
        performance.totalMs ?? performance.total_ms ?? performance.total
    );

    collected[label] = {
        transferToWorkerMs,
        executionMs,
        transferToMainMs,
        totalMs
    };

    targetMsg.performance = collected;
}

function mergeResult(originalMsg, resultData) {
    if (resultData === null || resultData === undefined) {
        return resultData;
    }

    if (Array.isArray(resultData)) {
        return resultData.map((entry) => mergeResult(originalMsg, entry));
    }

    if (typeof resultData === 'object') {
        return Object.assign({}, originalMsg, resultData);
    }

    return resultData;
}

function applyPerformanceToResult(node, originalMsg, resultData, performance) {
    if (resultData === null || resultData === undefined) {
        return;
    }

    if (Array.isArray(resultData)) {
        resultData.forEach((entry) => applyPerformanceToResult(node, originalMsg, entry, performance));
        return;
    }

    if (typeof resultData === 'object') {
        applyPerformanceMetrics(node, originalMsg, resultData, performance);
    }
}

/**
 * Update node status with pool statistics
 */
function updateStatus(node) {
    if (!node.pool) return;

    const stats = node.pool.getStats();

    // Format: "Active: 2/4 | Queue: 5 | SHM: 3" (SHM only shown if >0 files)
    let statusText = `Active: ${stats.busyWorkers}/${stats.totalWorkers} | Queue: ${stats.queuedTasks}`;
    if (stats.sharedMemory && stats.sharedMemory.activeFiles > 0) {
        statusText += ` | SHM: ${stats.sharedMemory.activeFiles}`;
    }

    // Color logic
    let fill = 'green';
    let shape = 'dot';

    if (stats.queuedTasks > 50) {
        fill = 'yellow';  // Queue getting full
    }
    if (stats.queuedTasks >= stats.config.maxQueueSize * 0.9) {
        fill = 'red';  // Queue almost full
    }
    if (stats.busyWorkers === stats.totalWorkers && stats.queuedTasks > 0) {
        shape = 'ring';  // All workers busy + queue
    }

    node.status({
        fill: fill,
        shape: shape,
        text: statusText
    });
}

module.exports = function(RED) {
    /**
     * Async Function Node Constructor
     * @param {object} config - Node configuration
     */
    function AsyncFunctionNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // Store configuration
        node.func = config.func || 'return msg;';
        node.outputs = config.outputs || 1;
        node.timeout = config.timeout || 30000;
        node.name = config.name || '';
        node.errorRecoveryTimer = null;  // Track error recovery timer
        const modeValue = typeof config.executionMode === 'string' ? config.executionMode.trim() : '';
        node.executionMode = modeValue.toLowerCase() === 'child_process' ? 'child_process' : 'worker_threads';

        // Migrate old config to new format (backwards compatibility)
        if (config.minWorkers !== undefined || config.maxWorkers !== undefined) {
            config.numWorkers = config.maxWorkers || config.minWorkers || 3;
            node.warn('Configuration migrated: minWorkers/maxWorkers → numWorkers=' + config.numWorkers);
        }

        // Store libs configuration
        node.libs = Array.isArray(config.libs) ? config.libs : [];

        if (RED.settings.functionExternalModules === false && node.libs.length > 0) {
            node.error('External modules are disabled by Node-RED settings.');
            node.status({
                fill: 'red',
                shape: 'dot',
                text: 'Modules disabled'
            });
            return;
        }

        const nodeRedUserDir = resolveNodeRedUserDir(RED);
        const transferMode = normalizeTransferMode(config.transferMode, node.executionMode);

        // Module resolution happens inside workers to avoid blocking the main thread.

        const startPool = () => {
            try {
                const PoolImpl = node.executionMode === 'child_process' ? ChildProcessPool : WorkerPool;
                node.pool = new PoolImpl({
                    numWorkers: config.numWorkers || 3,
                    maxQueueSize: config.maxQueueSize || 100,
                    taskTimeout: node.timeout,
                    shmThreshold: 0,
                    transferMode,
                    libs: node.libs,
                    nodeRedUserDir
                });
            } catch (err) {
                node.error('Failed to create worker pool: ' + err.message);
                node.status({
                    fill: 'red',
                    shape: 'dot',
                    text: 'Pool creation failed'
                });
                return;
            }

            node.pool.initialize().then(() => {
                updateStatus(node);
                // Start periodic status updates
                node.statusInterval = setInterval(() => {
                    updateStatus(node);
                }, 2000);  // Update every 2 seconds
            }).catch(err => {
                node.error('Failed to initialize worker pool: ' + err.message);
                node.status({
                    fill: 'red',
                    shape: 'dot',
                    text: 'Init failed'
                });
            });
        };

        // Start the pool directly - module validation already done synchronously above
        startPool();

        // Handle incoming messages
        node.on('input', async function(msg, send, done) {
            // Backwards compatibility with older Node-RED versions
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) {
                if (err) {
                    node.error(err, msg);
                }
            };

            if (!node.pool) {
                done(new Error('Worker pool is not initialized'));
                return;
            }

            const timing = { start: process.hrtime.bigint() };
            const contextInfo = await buildContextSnapshot(node, node.func);
            const workerMsg = buildWorkerInputMsg(msg, node.func, contextInfo.snapshot, contextInfo.usesContext);

            try {
                const payload = await node.pool.executeTask(node.func, workerMsg, node.timeout);

                let resultData;
                let performanceData = null;
                let contextUpdates = null;
                let logs = null;

                if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'result')) {
                    resultData = payload.result;
                    performanceData = payload.performance || null;
                    contextUpdates = payload.contextUpdates || null;
                    logs = payload.logs || null;
                } else {
                    resultData = payload;
                }

                if (resultData === null || resultData === undefined) {
                    await applyContextUpdates(node, contextUpdates, msg);
                    applyWorkerLogs(node, logs, msg);
                    done();
                    return;
                }

                const totalMs = hrtimeDiffToMs(timing.start);
                const mergedPerformance = Object.assign({}, performanceData || {});
                mergedPerformance.totalMs = totalMs;

                await applyContextUpdates(node, contextUpdates, msg);
                applyWorkerLogs(node, logs, msg);

                const output = mergeResult(msg, resultData);
                applyPerformanceToResult(node, msg, output, mergedPerformance);

                send(output);
                done();
                // Status updated by periodic interval (every 2s) - no per-message update needed
            } catch (err) {
                // Handle errors
                node.status({
                    fill: 'red',
                    shape: 'dot',
                    text: `Error: ${err.message.substring(0, 20)}`
                });

                if (err && err.contextUpdates) {
                    await applyContextUpdates(node, err.contextUpdates, msg);
                }
                if (err && err.logs) {
                    applyWorkerLogs(node, err.logs, msg);
                }

                // Log error
                node.error(`Worker function error: ${err.message}`, msg);

                // Propagate error to Catch node
                done(err);

                // Restore normal status after 3 seconds (clear any existing timer first)
                if (node.errorRecoveryTimer) {
                    clearTimeout(node.errorRecoveryTimer);
                }
                node.errorRecoveryTimer = setTimeout(() => {
                    node.errorRecoveryTimer = null;
                    updateStatus(node);
                }, 3000);
            }
        });

        // Handle node close
        node.on('close', async function(removed, done) {
            // Clear status interval
            if (node.statusInterval) {
                clearInterval(node.statusInterval);
            }

            // Clear error recovery timer
            if (node.errorRecoveryTimer) {
                clearTimeout(node.errorRecoveryTimer);
                node.errorRecoveryTimer = null;
            }

            node.status({});

            // Shutdown per-node pool
            if (node.pool) {
                try {
                    await node.pool.shutdown();
                } catch (err) {
                    node.error('Error shutting down worker pool: ' + err.message);
                }
            }

            if (done) {
                done();
            }
        });
    }

    // Register the node type
    RED.nodes.registerType('worker-function', AsyncFunctionNode, {
        dynamicModuleList: 'libs'
    });

    // HTTP endpoint to restart workers for a specific node
    RED.httpAdmin.post('/worker-function/:id/restart', async function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (!node || !node.pool) {
            return res.status(404).json({ error: 'Node not found or pool not initialized' });
        }

        try {
            await node.pool.shutdown();
            node.pool.initialized = false;
            node.pool.shuttingDown = false;
            await node.pool.initialize();
            updateStatus(node);
            res.json({ success: true, message: 'Workers restarted' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
};
