/**
 * Worker Pool Manager
 *
 * Manages a pool of worker threads for executing async function code.
 * Handles task queuing, worker lifecycle, timeouts, and error recovery.
 */

const { Worker } = require('worker_threads');
const path = require('path');
const TimeoutManager = require('./timeout-manager');
const { SharedMemoryManager } = require('./shared-memory-manager');
const { AsyncMessageSerializer } = require('./message-serializer');

// Default configuration
const DEFAULT_CONFIG = {
    numWorkers: 3,              // Fixed worker count
    taskTimeout: 30000,         // Default task timeout: 30s
    maxQueueSize: 100,          // Max queued messages
    shmThreshold: 0,            // Always use shared memory for Buffers
    transferMode: 'transfer',   // transfer | shared | copy
    libs: [],                   // External modules to load in workers
    nodeRedUserDir: null,       // Node-RED user directory for module resolution
    workerScript: path.join(__dirname, 'worker-script.js')
};

// Worker states
const WorkerState = {
    IDLE: 'idle',
    BUSY: 'busy',
    STARTING: 'starting',
    TERMINATING: 'terminating'
};

class WorkerPool {
    /**
     * Create a worker pool
     * @param {object} config - Configuration options
     */
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.workers = [];              // Array of { worker, state, taskId, idleTimer }
        this.taskQueue = [];            // Array of { taskId, code, msg, callback, timeout }
        this.nextTaskId = 0;
        this.callbacks = new Map();     // taskId → callback
        this.timeoutManager = new TimeoutManager();
        this.initialized = false;
        this.shuttingDown = false;

        // Shared memory management
        this.shmManager = new SharedMemoryManager({ threshold: this.config.shmThreshold });
        this.serializer = new AsyncMessageSerializer(this.shmManager);
    }

    /**
     * Initialize the worker pool
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        // Create exactly numWorkers workers
        const promises = [];
        for (let i = 0; i < this.config.numWorkers; i++) {
            promises.push(this.createWorker());
        }

        await Promise.all(promises);
        this.initialized = true;
    }

    /**
     * Create a new worker
     * @returns {Promise<object>} Worker state object
     */
    createWorker() {
        return new Promise((resolve, reject) => {
            try {
                const worker = new Worker(this.config.workerScript, {
                    workerData: {
                        shmThreshold: this.config.shmThreshold,
                        transferMode: this.config.transferMode,
                        libs: this.config.libs || [],
                        nodeRedUserDir: this.config.nodeRedUserDir
                    }
                });

                const workerState = {
                    worker,
                    state: WorkerState.STARTING,
                    taskId: null,
                    startTime: Date.now(),
                    markedForRemoval: false
                };

                // Setup event handlers
                worker.on('message', (msg) => this.handleWorkerMessage(workerState, msg));
                worker.on('error', (err) => this.handleWorkerError(workerState, err));
                worker.on('exit', (code) => this.handleWorkerExit(workerState, code));

                // Wait for ready signal
                const readyTimeout = setTimeout(() => {
                    reject(new Error('Worker failed to start within timeout'));
                }, 5000);

                worker.on('message', (msg) => {
                    if (msg.type === 'ready') {
                        clearTimeout(readyTimeout);
                        if (msg.failedModules && msg.failedModules.length > 0) {
                            const detail = msg.failedModules
                                .map((failed) => `${failed.module} (${failed.var}): ${failed.error}`)
                                .join('; ');
                            const err = new Error(`Worker failed to load module(s): ${detail}`);
                            err.failedModules = msg.failedModules;
                            worker.terminate().finally(() => {
                                reject(err);
                            });
                            return;
                        }

                        workerState.state = WorkerState.IDLE;
                        this.workers.push(workerState);
                        resolve(workerState);
                    }
                });

            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Resize the worker pool gracefully
     * @param {number} newNumWorkers - New target worker count
     * @returns {Promise<void>}
     */
    async resizePool(newNumWorkers) {
        if (this.shuttingDown) {
            throw new Error('Cannot resize pool during shutdown');
        }

        if (newNumWorkers < 1) {
            throw new Error('numWorkers must be at least 1');
        }

        const currentCount = this.workers.length;
        const delta = newNumWorkers - currentCount;

        if (delta === 0) {
            return; // No change needed
        }

        if (delta > 0) {
            // Scale up: Add new workers
            const promises = [];
            for (let i = 0; i < delta; i++) {
                promises.push(this.createWorker());
            }
            await Promise.all(promises);
        } else {
            // Scale down: Gracefully remove workers
            const toRemoveCount = Math.abs(delta);
            const idleWorkers = this.workers.filter(w => w.state === WorkerState.IDLE);

            // Immediately terminate idle workers
            const toTerminate = idleWorkers.slice(0, toRemoveCount);
            await Promise.all(toTerminate.map(w => this.terminateWorker(w)));

            // Mark remaining busy workers for removal after task completion
            const remainingToRemove = toRemoveCount - toTerminate.length;
            if (remainingToRemove > 0) {
                const busyWorkers = this.workers.filter(w => w.state === WorkerState.BUSY);
                for (let i = 0; i < remainingToRemove && i < busyWorkers.length; i++) {
                    busyWorkers[i].markedForRemoval = true;
                }
            }
        }

        // Update config
        this.config.numWorkers = newNumWorkers;
    }

    /**
     * Get an idle worker
     * @returns {object|null} Worker state object or null if none available
     */
    async acquireWorker() {
        // Find and return idle worker (no dynamic creation)
        return this.workers.find(w => w.state === WorkerState.IDLE) || null;
    }

    /**
     * Execute a task on a worker
     * @param {string} code - User function code
     * @param {object} msg - Message object
     * @param {number} timeout - Timeout in milliseconds
     * @returns {Promise<object>} Result
     */
    async executeTask(code, msg, timeout = this.config.taskTimeout) {
        if (!this.initialized) {
            await this.initialize();
        }

        if (this.shuttingDown) {
            throw new Error('Worker pool is shutting down');
        }

        const taskId = this.nextTaskId++;

        return new Promise((resolve, reject) => {
            const callback = (err, payload) => {
                // Cleanup shared memory on completion (success or error)
                this.shmManager.cleanupTask(taskId).catch(_cleanupErr => {
                    // Log but don't fail - task already completed
                });

                if (err) {
                    reject(err);
                } else {
                    resolve(payload);
                }
            };

            this.callbacks.set(taskId, callback);

            // Try to acquire a worker
            this.acquireWorker().then(workerState => {
                if (workerState) {
                    // Worker available, run task immediately
                    this.runTask(workerState, taskId, code, msg, timeout);
                } else {
                    // No worker available, queue the task
                    if (this.taskQueue.length >= this.config.maxQueueSize) {
                        this.callbacks.delete(taskId);
                        // Cleanup shared memory on queue rejection
                        this.shmManager.cleanupTask(taskId).catch(_cleanupErr => {});
                        reject(new Error('Task queue full'));
                        return;
                    }

                    this.taskQueue.push({ taskId, code, msg, timeout, callback });
                }
            }).catch(err => {
                this.callbacks.delete(taskId);
                // Cleanup shared memory on error
                this.shmManager.cleanupTask(taskId).catch(_cleanupErr => {});
                reject(err);
            });
        });
    }

    /**
     * Run a task on a specific worker
     * @param {object} workerState - Worker state object
     * @param {number} taskId - Task ID
     * @param {string} code - User function code
     * @param {object} msg - Message object
     * @param {number} timeout - Timeout in milliseconds
     */
    runTask(workerState, taskId, code, msg, timeout) {
        // Update worker state
        workerState.state = WorkerState.BUSY;
        workerState.taskId = taskId;

        const transferList = this.config.transferMode === 'transfer' ? [] : null;
        const transferSet = transferList ? new Set() : null;

        this.serializer.sanitizeMessage(msg, null, taskId, {
            transferMode: this.config.transferMode,
            transferList,
            transferSet
        }).then(sanitizedMsg => {
            // Start timeout after message preparation (matches hot-mode behavior)
            this.timeoutManager.startTimeout(taskId, timeout, () => {
                this.handleTimeout(workerState, taskId);
            });

            // Send task to worker
            const payload = {
                type: 'execute',
                taskId,
                code,
                msg: sanitizedMsg
            };
            if (transferList && transferList.length > 0) {
                workerState.worker.postMessage(payload, transferList);
            } else {
                workerState.worker.postMessage(payload);
            }
        }).catch(err => {
            // Fail task if message prep fails
            const callback = this.callbacks.get(taskId);
            if (callback) {
                this.callbacks.delete(taskId);
                callback(new Error(`Message sanitization failed: ${err.message}`), null);
            }
            this.recycleWorker(workerState);
        });
    }

    /**
     * Handle message from worker
     * @param {object} workerState - Worker state object
     * @param {object} message - Message from worker
     */
    handleWorkerMessage(workerState, message) {
        const { type, taskId, result, error, performance, contextUpdates, logs } = message || {};

        if (type === 'result') {
            // Task completed successfully
            this.timeoutManager.cancelTimeout(taskId);

            const callback = this.callbacks.get(taskId);
            if (callback) {
                this.callbacks.delete(taskId);
                // Recycle worker immediately; result restoration happens asynchronously
                this.recycleWorker(workerState);

                const restoreResult = this.serializer.restoreBuffers(result);
                const restoreContext = contextUpdates
                    ? this.serializer.restoreBuffers(contextUpdates)
                    : Promise.resolve(contextUpdates);

                Promise.all([restoreResult, restoreContext]).then(([restoredResult, restoredContext]) => {
                    callback(null, {
                        result: restoredResult,
                        performance: performance || null,
                        contextUpdates: restoredContext || null,
                        logs: Array.isArray(logs) ? logs : null
                    });
                }).catch(restoreErr => {
                    callback(restoreErr instanceof Error ? restoreErr : new Error(String(restoreErr)), null);
                });
                return;
            }

            // Return worker to idle state
            this.recycleWorker(workerState);

        } else if (type === 'error') {
            // Task failed with error
            this.timeoutManager.cancelTimeout(taskId);

            const callback = this.callbacks.get(taskId);
            if (callback) {
                this.callbacks.delete(taskId);
                const err = new Error(error && error.message ? error.message : 'Worker error');
                err.stack = error && error.stack ? error.stack : err.stack;
                err.name = error && error.name ? error.name : err.name;

                if (contextUpdates) {
                    this.serializer.restoreBuffers(contextUpdates).then(restoredContext => {
                        err.contextUpdates = restoredContext;
                        err.logs = Array.isArray(logs) ? logs : null;
                        callback(err, null);
                    }).catch(() => {
                        err.logs = Array.isArray(logs) ? logs : null;
                        callback(err, null);
                    });
                } else {
                    err.logs = Array.isArray(logs) ? logs : null;
                    callback(err, null);
                }
            }

            // Return worker to idle state
            this.recycleWorker(workerState);
        }
    }

    /**
     * Handle worker error
     * @param {object} workerState - Worker state object
     * @param {Error} err - Error object
     */
    async handleWorkerError(workerState, err) {
        // Cancel timeout if task was running
        if (workerState.taskId !== null) {
            this.timeoutManager.cancelTimeout(workerState.taskId);

            // Cleanup shared memory for crashed task
            this.shmManager.cleanupTask(workerState.taskId).catch(_cleanupErr => {
                // Log but don't fail
            });

            const callback = this.callbacks.get(workerState.taskId);
            if (callback) {
                this.callbacks.delete(workerState.taskId);
                callback(new Error(`Worker error: ${err.message}`), null);
            }
        }

        // Remove worker from pool
        this.removeWorker(workerState);

        // Create replacement if below target
        if (this.workers.length < this.config.numWorkers && !this.shuttingDown) {
            try {
                await this.createWorker();
            } catch (createErr) {
                // Failed to create replacement
            }
        }
    }

    /**
     * Handle worker exit
     * @param {object} workerState - Worker state object
     * @param {number} code - Exit code
     */
    async handleWorkerExit(workerState, code) {
        if (code !== 0 && workerState.state !== WorkerState.TERMINATING) {
            // Worker crashed unexpectedly
            await this.handleWorkerError(workerState, new Error(`Worker exited with code ${code}`));
        }
    }

    /**
     * Handle task timeout
     * @param {object} workerState - Worker state object
     * @param {number} taskId - Task ID
     */
    async handleTimeout(workerState, taskId) {
        // Cleanup shared memory for timed out task
        this.shmManager.cleanupTask(taskId).catch(_cleanupErr => {
            // Log but don't fail
        });

        // Terminate the worker
        workerState.state = WorkerState.TERMINATING;

        try {
            await workerState.worker.terminate();
        } catch (err) {
            // Ignore termination errors
        }

        // Remove from pool
        this.removeWorker(workerState);

        // Fail the task
        const callback = this.callbacks.get(taskId);
        if (callback) {
            this.callbacks.delete(taskId);
            callback(new Error('Execution timeout'), null);
        }

        // Create replacement worker
        if (this.workers.length < this.config.numWorkers && !this.shuttingDown) {
            try {
                await this.createWorker();
            } catch (err) {
                // Failed to create replacement
            }
        }

        // Process next queued task
        this.processQueue();
    }

    /**
     * Recycle a worker after task completion
     * @param {object} workerState - Worker state object
     */
    recycleWorker(workerState) {
        workerState.state = WorkerState.IDLE;
        workerState.taskId = null;

        // Check if marked for removal (for resize support)
        if (workerState.markedForRemoval) {
            this.terminateWorker(workerState).catch(_err => {
                // Log but don't fail
            });
            this.processQueue();
            return;
        }

        // Process next queued task
        if (this.taskQueue.length > 0) {
            const task = this.taskQueue.shift();
            this.runTask(workerState, task.taskId, task.code, task.msg, task.timeout);
        }
    }

    /**
     * Process the task queue
     */
    processQueue() {
        if (this.taskQueue.length === 0) {
            return;
        }

        // Find idle worker
        const workerState = this.workers.find(w => w.state === WorkerState.IDLE);
        if (workerState) {
            const task = this.taskQueue.shift();
            this.runTask(workerState, task.taskId, task.code, task.msg, task.timeout);
        }
    }

    /**
     * Terminate a worker
     * @param {object} workerState - Worker state object
     */
    async terminateWorker(workerState) {
        workerState.state = WorkerState.TERMINATING;

        try {
            await workerState.worker.terminate();
        } catch (err) {
            // Ignore termination errors
        }

        this.removeWorker(workerState);
    }

    /**
     * Remove a worker from the pool
     * @param {object} workerState - Worker state object
     */
    removeWorker(workerState) {
        this.workers = this.workers.filter(w => w !== workerState);
    }

    /**
     * Shutdown the worker pool
     * @returns {Promise<void>}
     */
    async shutdown() {
        this.shuttingDown = true;

        // Cancel all timeouts
        this.timeoutManager.clear();

        // Fail all queued tasks
        for (const task of this.taskQueue) {
            const callback = this.callbacks.get(task.taskId);
            if (callback) {
                this.callbacks.delete(task.taskId);
                callback(new Error('Worker pool shutdown'), null);
            }
        }
        this.taskQueue = [];

        // Terminate all workers
        const promises = this.workers.map(ws => this.terminateWorker(ws));
        await Promise.all(promises);

        // Cleanup all shared memory attachments
        await this.shmManager.cleanupAll();

        this.initialized = false;
    }

    /**
     * Get pool statistics
     * @returns {object} Statistics object
     */
    getStats() {
        const idleWorkers = this.workers.filter(w => w.state === WorkerState.IDLE).length;
        const busyWorkers = this.workers.filter(w => w.state === WorkerState.BUSY).length;
        const markedForRemoval = this.workers.filter(w => w.markedForRemoval).length;

        return {
            totalWorkers: this.workers.length,
            targetWorkers: this.config.numWorkers,
            idleWorkers,
            busyWorkers,
            markedForRemoval,
            queuedTasks: this.taskQueue.length,
            activeTasks: this.timeoutManager.getActiveCount(),
            sharedMemory: this.shmManager.getStats(),
            config: this.config
        };
    }
}

module.exports = {
    WorkerPool
};
