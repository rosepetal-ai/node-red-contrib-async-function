/**
 * Worker Pool Manager
 *
 * Manages a pool of worker threads for executing async function code.
 * Handles task queuing, worker lifecycle, timeouts, and error recovery.
 */

const { Worker } = require('worker_threads');
const path = require('path');
const TimeoutManager = require('./timeout-manager');

// Default configuration
const DEFAULT_CONFIG = {
    minWorkers: 2,              // Always keep 2 workers alive
    maxWorkers: 4,              // Maximum 4 concurrent workers
    idleTimeout: 60000,         // Kill idle workers after 60s
    taskTimeout: 30000,         // Default task timeout: 30s
    maxQueueSize: 100,          // Max queued messages
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
    }

    /**
     * Initialize the worker pool
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        // Create minimum workers
        const promises = [];
        for (let i = 0; i < this.config.minWorkers; i++) {
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
                const worker = new Worker(this.config.workerScript);

                const workerState = {
                    worker,
                    state: WorkerState.STARTING,
                    taskId: null,
                    idleTimer: null,
                    startTime: Date.now()
                };

                // Setup event handlers
                worker.on('message', (msg) => this.handleWorkerMessage(workerState, msg));
                worker.on('error', (err) => this.handleWorkerError(workerState, err));
                worker.on('exit', (code) => this.handleWorkerExit(workerState, code));

                // Wait for ready signal
                const readyTimeout = setTimeout(() => {
                    reject(new Error('Worker failed to start within timeout'));
                }, 5000);

                const originalHandler = worker.on('message', (msg) => {
                    if (msg.type === 'ready') {
                        clearTimeout(readyTimeout);
                        workerState.state = WorkerState.IDLE;
                        this.workers.push(workerState);
                        this.startIdleTimer(workerState);
                        resolve(workerState);
                    }
                });

            } catch (err) {
                reject(err);
            }
        });
    }

    /**
     * Get an idle worker or create a new one
     * @returns {object|null} Worker state object or null if none available
     */
    async acquireWorker() {
        // Find idle worker
        let workerState = this.workers.find(w => w.state === WorkerState.IDLE);

        // If no idle worker and below max, create new one
        if (!workerState && this.workers.length < this.config.maxWorkers) {
            try {
                workerState = await this.createWorker();
            } catch (err) {
                // Failed to create worker
                return null;
            }
        }

        return workerState;
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

        return new Promise((resolve, reject) => {
            const taskId = this.nextTaskId++;
            const callback = (err, result) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(result);
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
                        reject(new Error('Task queue full'));
                        return;
                    }

                    this.taskQueue.push({ taskId, code, msg, timeout, callback });
                }
            }).catch(err => {
                this.callbacks.delete(taskId);
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
        // Clear idle timer
        this.clearIdleTimer(workerState);

        // Update worker state
        workerState.state = WorkerState.BUSY;
        workerState.taskId = taskId;

        // Start timeout
        this.timeoutManager.startTimeout(taskId, timeout, () => {
            this.handleTimeout(workerState, taskId);
        });

        // Send task to worker
        workerState.worker.postMessage({
            type: 'execute',
            taskId,
            code,
            msg
        });
    }

    /**
     * Handle message from worker
     * @param {object} workerState - Worker state object
     * @param {object} message - Message from worker
     */
    handleWorkerMessage(workerState, message) {
        const { type, taskId, result, error } = message;

        if (type === 'result') {
            // Task completed successfully
            this.timeoutManager.cancelTimeout(taskId);

            const callback = this.callbacks.get(taskId);
            if (callback) {
                this.callbacks.delete(taskId);
                callback(null, result);
            }

            // Return worker to idle state
            this.recycleWorker(workerState);

        } else if (type === 'error') {
            // Task failed with error
            this.timeoutManager.cancelTimeout(taskId);

            const callback = this.callbacks.get(taskId);
            if (callback) {
                this.callbacks.delete(taskId);
                const err = new Error(error.message);
                err.stack = error.stack;
                err.name = error.name;
                callback(err, null);
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

            const callback = this.callbacks.get(workerState.taskId);
            if (callback) {
                this.callbacks.delete(workerState.taskId);
                callback(new Error(`Worker error: ${err.message}`), null);
            }
        }

        // Remove worker from pool
        this.removeWorker(workerState);

        // Create replacement if below minimum
        if (this.workers.length < this.config.minWorkers && !this.shuttingDown) {
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
        if (this.workers.length < this.config.minWorkers && !this.shuttingDown) {
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

        // Process next queued task
        if (this.taskQueue.length > 0) {
            const task = this.taskQueue.shift();
            this.runTask(workerState, task.taskId, task.code, task.msg, task.timeout);
        } else {
            // Start idle timer
            this.startIdleTimer(workerState);
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
     * Start idle timer for a worker
     * @param {object} workerState - Worker state object
     */
    startIdleTimer(workerState) {
        this.clearIdleTimer(workerState);

        workerState.idleTimer = setTimeout(() => {
            // Kill idle worker if above minimum
            if (this.workers.length > this.config.minWorkers) {
                this.terminateWorker(workerState);
            }
        }, this.config.idleTimeout);
    }

    /**
     * Clear idle timer for a worker
     * @param {object} workerState - Worker state object
     */
    clearIdleTimer(workerState) {
        if (workerState.idleTimer) {
            clearTimeout(workerState.idleTimer);
            workerState.idleTimer = null;
        }
    }

    /**
     * Terminate a worker
     * @param {object} workerState - Worker state object
     */
    async terminateWorker(workerState) {
        workerState.state = WorkerState.TERMINATING;
        this.clearIdleTimer(workerState);

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
        this.clearIdleTimer(workerState);
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

        this.initialized = false;
    }

    /**
     * Get pool statistics
     * @returns {object} Statistics object
     */
    getStats() {
        const idleWorkers = this.workers.filter(w => w.state === WorkerState.IDLE).length;
        const busyWorkers = this.workers.filter(w => w.state === WorkerState.BUSY).length;

        return {
            totalWorkers: this.workers.length,
            idleWorkers,
            busyWorkers,
            queuedTasks: this.taskQueue.length,
            activeTasks: this.timeoutManager.getActiveCount(),
            config: this.config
        };
    }
}

// Singleton instance
let globalInstance = null;

/**
 * Get or create the global worker pool instance
 * @param {object} config - Configuration options
 * @returns {WorkerPool} Worker pool instance
 */
function getGlobalPool(config) {
    if (!globalInstance) {
        globalInstance = new WorkerPool(config);
    }
    return globalInstance;
}

/**
 * Shutdown the global worker pool
 * @returns {Promise<void>}
 */
async function shutdownGlobalPool() {
    if (globalInstance) {
        await globalInstance.shutdown();
        globalInstance = null;
    }
}

module.exports = {
    WorkerPool,
    getGlobalPool,
    shutdownGlobalPool
};
