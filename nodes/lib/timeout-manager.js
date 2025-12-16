/**
 * Timeout Manager
 *
 * Tracks timeouts for async tasks and invokes callbacks when timeouts expire.
 * Provides centralized timeout management for the worker pool.
 */

class TimeoutManager {
    constructor() {
        this.timeouts = new Map(); // taskId → { handle, callback, startTime }
    }

    /**
     * Start a timeout for a task
     *
     * @param {number|string} taskId - Unique task identifier
     * @param {number} duration - Timeout duration in milliseconds
     * @param {Function} onTimeout - Callback to invoke on timeout
     * @returns {void}
     */
    startTimeout(taskId, duration, onTimeout) {
        // Cancel existing timeout if any
        this.cancelTimeout(taskId);

        const startTime = Date.now();
        const handle = setTimeout(() => {
            this.timeouts.delete(taskId);
            onTimeout(taskId);
        }, duration);

        this.timeouts.set(taskId, {
            handle,
            callback: onTimeout,
            startTime,
            duration
        });
    }

    /**
     * Cancel a timeout for a task
     *
     * @param {number|string} taskId - Task identifier
     * @returns {boolean} True if timeout was cancelled, false if not found
     */
    cancelTimeout(taskId) {
        const timeout = this.timeouts.get(taskId);
        if (timeout) {
            clearTimeout(timeout.handle);
            this.timeouts.delete(taskId);
            return true;
        }
        return false;
    }

    /**
     * Check if a timeout exists for a task
     *
     * @param {number|string} taskId - Task identifier
     * @returns {boolean} True if timeout exists
     */
    hasTimeout(taskId) {
        return this.timeouts.has(taskId);
    }

    /**
     * Get elapsed time for a task
     *
     * @param {number|string} taskId - Task identifier
     * @returns {number|null} Elapsed time in milliseconds, or null if not found
     */
    getElapsedTime(taskId) {
        const timeout = this.timeouts.get(taskId);
        if (timeout) {
            return Date.now() - timeout.startTime;
        }
        return null;
    }

    /**
     * Get remaining time for a task
     *
     * @param {number|string} taskId - Task identifier
     * @returns {number|null} Remaining time in milliseconds, or null if not found
     */
    getRemainingTime(taskId) {
        const timeout = this.timeouts.get(taskId);
        if (timeout) {
            const elapsed = Date.now() - timeout.startTime;
            return Math.max(0, timeout.duration - elapsed);
        }
        return null;
    }

    /**
     * Get number of active timeouts
     *
     * @returns {number} Number of active timeouts
     */
    getActiveCount() {
        return this.timeouts.size;
    }

    /**
     * Clear all timeouts
     *
     * @returns {void}
     */
    clear() {
        for (const timeout of this.timeouts.values()) {
            clearTimeout(timeout.handle);
        }
        this.timeouts.clear();
    }

    /**
     * Get statistics about timeouts
     *
     * @returns {object} Statistics object
     */
    getStats() {
        const stats = {
            activeCount: this.timeouts.size,
            tasks: []
        };

        for (const [taskId, timeout] of this.timeouts.entries()) {
            stats.tasks.push({
                taskId,
                elapsed: Date.now() - timeout.startTime,
                remaining: Math.max(0, timeout.duration - (Date.now() - timeout.startTime)),
                duration: timeout.duration
            });
        }

        return stats;
    }
}

module.exports = TimeoutManager;
