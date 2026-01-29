/**
 * Child Process Pool Manager
 *
 * Manages a pool of child processes for executing async function code.
 * Handles task queuing, process lifecycle, timeouts, and error recovery.
 */

const { fork } = require('child_process');
const path = require('path');
const TimeoutManager = require('./timeout-manager');
const { SharedMemoryManager } = require('./shared-memory-manager');
const { AsyncMessageSerializer } = require('./message-serializer');

// Default configuration
const DEFAULT_CONFIG = {
    numWorkers: 3,              // Fixed process count
    taskTimeout: 30000,         // Default task timeout: 30s
    maxQueueSize: 100,          // Max queued messages
    shmThreshold: 0,            // Always use shared memory for Buffers
    transferMode: 'shared',     // shared | copy (transfer not supported for child processes)
    libs: [],                   // External modules to load in workers
    nodeRedUserDir: null,       // Node-RED user directory for module resolution
    workerScript: path.join(__dirname, 'child-process-script.js')
};

// Worker states
const WorkerState = {
    IDLE: 'idle',
    BUSY: 'busy',
    STARTING: 'starting',
    TERMINATING: 'terminating'
};

class ChildProcessPool {
    /**
     * Create a child process pool
     * @param {object} config - Configuration options
     */
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.workers = [];              // Array of { worker, state, taskId, idleTimer }
        this.taskQueue = [];            // Array of { taskId, code, msg, callback, timeout }
        this.nextTaskId = 0;
        this.callbacks = new Map();     // taskId -> callback
        this.timeoutManager = new TimeoutManager();
        this.initialized = false;
        this.shuttingDown = false;

        // Shared memory management
        this.shmManager = new SharedMemoryManager({ threshold: this.config.shmThreshold });
        this.serializer = new AsyncMessageSerializer(this.shmManager);
    }

    /**
     * Initialize the process pool
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        const promises = [];
        for (let i = 0; i < this.config.numWorkers; i++) {
            promises.push(this.createWorker());
        }

        await Promise.all(promises);
        this.initialized = true;
    }

    /**
     * Create a new child process
     * @returns {Promise<object>} Worker state object
     */
    createWorker() {
        return new Promise((resolve, reject) => {
            let settled = false;

            const child = fork(this.config.workerScript, [], {
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                serialization: 'advanced'
            });

            const workerState = {
                worker: child,
                state: WorkerState.STARTING,
                taskId: null,
                startTime: Date.now(),
                markedForRemoval: false
            };

            const readyTimeout = setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                try {
                    child.kill();
                } catch (_err) {
                    // Ignore kill errors
                }
                reject(new Error('Worker failed to start within timeout'));
            }, 5000);

            const handleReady = (msg) => {
                if (!msg || typeof msg !== 'object') {
                    return;
                }

                if (msg.type === 'ready') {
                    clearTimeout(readyTimeout);
                    if (settled) {
                        return;
                    }
                    settled = true;

                    if (msg.failedModules && msg.failedModules.length > 0) {
                        const detail = msg.failedModules
                            .map((failed) => `${failed.module} (${failed.var}): ${failed.error}`)
                            .join('; ');
                        const err = new Error(`Worker failed to load module(s): ${detail}`);
                        err.failedModules = msg.failedModules;
                        try {
                            child.kill();
                        } catch (_err) {
                            // Ignore kill errors
                        }
                        reject(err);
                        return;
                    }

                    workerState.state = WorkerState.IDLE;
                    this.workers.push(workerState);
                    resolve(workerState);
                    return;
                }

                this.handleWorkerMessage(workerState, msg);
            };

            const handleError = (err) => {
                if (workerState.state === WorkerState.STARTING && !settled) {
                    settled = true;
                    clearTimeout(readyTimeout);
                    reject(err);
                }
                this.handleWorkerError(workerState, err);
            };

            const handleExit = (code, signal) => {
                if (workerState.state === WorkerState.STARTING && !settled) {
                    settled = true;
                    clearTimeout(readyTimeout);
                    const reason = code !== null ? `code ${code}` : `signal ${signal}`;
                    reject(new Error(`Worker exited during startup (${reason})`));
                }
                this.handleWorkerExit(workerState, code, signal);
            };

            child.on('message', handleReady);
            child.on('error', handleError);
            child.on('exit', handleExit);

            try {
                child.send({
                    type: 'init',
                    libs: this.config.libs || [],
                    nodeRedUserDir: this.config.nodeRedUserDir,
                    shmThreshold: this.config.shmThreshold,
                    transferMode: this.config.transferMode
                });
            } catch (err) {
                clearTimeout(readyTimeout);
                try {
                    child.kill();
                } catch (_killErr) {
                    // Ignore kill errors
                }
                reject(err);
            }
        });
    }

    /**
     * Resize the process pool gracefully
     * @param {number} newNumWorkers - New target process count
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
            return;
        }

        if (delta > 0) {
            const promises = [];
            for (let i = 0; i < delta; i++) {
                promises.push(this.createWorker());
            }
            await Promise.all(promises);
        } else {
            const toRemoveCount = Math.abs(delta);
            const idleWorkers = this.workers.filter(w => w.state === WorkerState.IDLE);

            const toTerminate = idleWorkers.slice(0, toRemoveCount);
            await Promise.all(toTerminate.map(w => this.terminateWorker(w)));

            const remainingToRemove = toRemoveCount - toTerminate.length;
            if (remainingToRemove > 0) {
                const busyWorkers = this.workers.filter(w => w.state === WorkerState.BUSY);
                for (let i = 0; i < remainingToRemove && i < busyWorkers.length; i++) {
                    busyWorkers[i].markedForRemoval = true;
                }
            }
        }

        this.config.numWorkers = newNumWorkers;
    }

    /**
     * Get an idle worker
     * @returns {object|null} Worker state object or null if none available
     */
    async acquireWorker() {
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
                this.shmManager.cleanupTask(taskId).catch(_cleanupErr => {});

                if (err) {
                    reject(err);
                } else {
                    resolve(payload);
                }
            };

            this.callbacks.set(taskId, callback);

            this.acquireWorker().then(workerState => {
                if (workerState) {
                    this.runTask(workerState, taskId, code, msg, timeout);
                } else {
                    if (this.taskQueue.length >= this.config.maxQueueSize) {
                        this.callbacks.delete(taskId);
                        this.shmManager.cleanupTask(taskId).catch(_cleanupErr => {});
                        reject(new Error('Task queue full'));
                        return;
                    }

                    this.taskQueue.push({ taskId, code, msg, timeout, callback });
                }
            }).catch(err => {
                this.callbacks.delete(taskId);
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
        workerState.state = WorkerState.BUSY;
        workerState.taskId = taskId;

        this.serializer.sanitizeMessage(msg, null, taskId, {
            transferMode: this.config.transferMode
        }).then(sanitizedMsg => {
            this.timeoutManager.startTimeout(taskId, timeout, () => {
                this.handleTimeout(workerState, taskId);
            });

            try {
                workerState.worker.send({
                    type: 'execute',
                    taskId,
                    code,
                    msg: sanitizedMsg
                });
            } catch (err) {
                this.handleWorkerError(workerState, err);
            }
        }).catch(err => {
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
        const { type, taskId, result, error, performance } = message || {};

        if (type === 'result') {
            this.timeoutManager.cancelTimeout(taskId);

            const callback = this.callbacks.get(taskId);
            if (callback) {
                this.callbacks.delete(taskId);
                this.recycleWorker(workerState);

                this.serializer.restoreBuffers(result).then(restoredResult => {
                    callback(null, { result: restoredResult, performance: performance || null });
                }).catch(restoreErr => {
                    callback(restoreErr instanceof Error ? restoreErr : new Error(String(restoreErr)), null);
                });
                return;
            }

            this.recycleWorker(workerState);

        } else if (type === 'error') {
            this.timeoutManager.cancelTimeout(taskId);

            const callback = this.callbacks.get(taskId);
            if (callback) {
                this.callbacks.delete(taskId);
                const err = new Error(error && error.message ? error.message : 'Worker error');
                if (error && error.stack) {
                    err.stack = error.stack;
                }
                if (error && error.name) {
                    err.name = error.name;
                }
                callback(err, null);
            }

            this.recycleWorker(workerState);
        }
    }

    /**
     * Handle worker error
     * @param {object} workerState - Worker state object
     * @param {Error} err - Error object
     */
    async handleWorkerError(workerState, err) {
        if (workerState.state === WorkerState.TERMINATING) {
            this.removeWorker(workerState);
            return;
        }

        workerState.state = WorkerState.TERMINATING;

        if (workerState.taskId !== null) {
            this.timeoutManager.cancelTimeout(workerState.taskId);

            this.shmManager.cleanupTask(workerState.taskId).catch(_cleanupErr => {});

            const callback = this.callbacks.get(workerState.taskId);
            if (callback) {
                this.callbacks.delete(workerState.taskId);
                callback(new Error(`Worker error: ${err.message}`), null);
            }
        }

        this.removeWorker(workerState);

        if (this.workers.length < this.config.numWorkers && !this.shuttingDown) {
            try {
                await this.createWorker();
            } catch (_createErr) {
                // Failed to create replacement
            }
        }
    }

    /**
     * Handle worker exit
     * @param {object} workerState - Worker state object
     * @param {number} code - Exit code
     * @param {string} signal - Exit signal
     */
    async handleWorkerExit(workerState, code, signal) {
        if (workerState.state === WorkerState.TERMINATING) {
            this.removeWorker(workerState);
            return;
        }

        const reason = signal ? `signal ${signal}` : `code ${code !== null ? code : 'unknown'}`;
        await this.handleWorkerError(workerState, new Error(`Worker exited (${reason})`));
    }

    /**
     * Handle task timeout
     * @param {object} workerState - Worker state object
     * @param {number} taskId - Task ID
     */
    async handleTimeout(workerState, taskId) {
        this.shmManager.cleanupTask(taskId).catch(_cleanupErr => {});

        workerState.state = WorkerState.TERMINATING;

        try {
            await this.terminateWorker(workerState);
        } catch (_err) {
            // Ignore termination errors
        }

        this.removeWorker(workerState);

        const callback = this.callbacks.get(taskId);
        if (callback) {
            this.callbacks.delete(taskId);
            callback(new Error('Execution timeout'), null);
        }

        if (this.workers.length < this.config.numWorkers && !this.shuttingDown) {
            try {
                await this.createWorker();
            } catch (_err) {
                // Failed to create replacement
            }
        }

        this.processQueue();
    }

    /**
     * Recycle a worker after task completion
     * @param {object} workerState - Worker state object
     */
    recycleWorker(workerState) {
        workerState.state = WorkerState.IDLE;
        workerState.taskId = null;

        if (workerState.markedForRemoval) {
            this.terminateWorker(workerState).catch(_err => {});
            this.processQueue();
            return;
        }

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
        const child = workerState.worker;

        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                resolve();
            };

            const timeout = setTimeout(() => {
                if (!child.killed) {
                    try {
                        child.kill();
                    } catch (_err) {
                        // Ignore kill errors
                    }
                }
                finish();
            }, 250);

            child.once('exit', () => {
                clearTimeout(timeout);
                finish();
            });

            child.once('error', () => {
                clearTimeout(timeout);
                finish();
            });

            if (child.connected) {
                try {
                    child.send({ type: 'terminate' });
                } catch (_err) {
                    // Ignore send errors
                }
            } else {
                try {
                    child.kill();
                } catch (_err) {
                    // Ignore kill errors
                }
            }
        });

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

        this.timeoutManager.clear();

        for (const task of this.taskQueue) {
            const callback = this.callbacks.get(task.taskId);
            if (callback) {
                this.callbacks.delete(task.taskId);
                callback(new Error('Worker pool shutdown'), null);
            }
        }
        this.taskQueue = [];

        const promises = this.workers.map(ws => this.terminateWorker(ws));
        await Promise.all(promises);

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
    ChildProcessPool
};
