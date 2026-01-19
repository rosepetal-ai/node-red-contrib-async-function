/**
 * Async Function Node
 *
 * A Node-RED function node that executes user code in worker threads
 * to prevent event loop blocking.
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

function buildWorkerInputMsg(originalMsg, code) {
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

function applyPerformanceMetrics(node, originalMsg, targetMsg, performance) {
    if (!performance || typeof performance !== 'object') {
        return;
    }

    const label = (typeof node.name === 'string' && node.name.trim()) ? node.name.trim() : 'async function';
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

        // Verify modules are resolvable WITHOUT loading them in the main thread.
        // Loading native modules (like 'gl') in main thread prevents them from
        // working in worker threads due to native module registration conflicts.
        if (node.libs.length > 0) {
            const { createRequire } = require('module');
            const nodeRedRequire = createRequire(path.join(nodeRedUserDir, 'package.json'));

            for (const lib of node.libs) {
                if (!lib || !lib.module || !lib.var) {
                    continue;
                }
                try {
                    // Only resolve the path - don't actually load the module
                    nodeRedRequire.resolve(lib.module);
                } catch (err) {
                    node.error(`Module "${lib.module}" not found. Install it with: cd ${nodeRedUserDir} && npm install ${lib.module}`);
                    node.status({
                        fill: 'red',
                        shape: 'dot',
                        text: `Module not found: ${lib.module}`
                    });
                    return;
                }
            }
        }

        const startPool = () => {
            try {
                const PoolImpl = node.executionMode === 'child_process' ? ChildProcessPool : WorkerPool;
                node.pool = new PoolImpl({
                    numWorkers: config.numWorkers || 3,
                    maxQueueSize: config.maxQueueSize || 100,
                    taskTimeout: node.timeout,
                    shmThreshold: 0,
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
            const workerMsg = buildWorkerInputMsg(msg, node.func);

            try {
                const payload = await node.pool.executeTask(node.func, workerMsg, node.timeout);

                let resultData;
                let performanceData = null;

                if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'result')) {
                    resultData = payload.result;
                    performanceData = payload.performance || null;
                } else {
                    resultData = payload;
                }

                if (resultData === null || resultData === undefined) {
                    done();
                    return;
                }

                const totalMs = hrtimeDiffToMs(timing.start);
                const mergedPerformance = Object.assign({}, performanceData || {});
                mergedPerformance.totalMs = totalMs;

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

                // Log error
                node.error(`Async function error: ${err.message}`, msg);

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
    RED.nodes.registerType('async-function', AsyncFunctionNode, {
        dynamicModuleList: 'libs'
    });

    // HTTP endpoint to restart workers for a specific node
    RED.httpAdmin.post('/async-function/:id/restart', async function(req, res) {
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
