/**
 * Async Message Serializer
 *
 * Safely clones messages for worker thread communication with async operation.
 * Offloads large buffers to shared memory to prevent event loop blocking.
 * Handles non-serializable properties, circular references, and special types.
 */

/**
 * Async Message Serializer Class
 * Handles message cloning with shared memory offloading for large buffers
 */
class AsyncMessageSerializer {
    /**
     * Create an async message serializer
     * @param {SharedMemoryManager} sharedMemoryManager - Shared memory manager instance
     * @param {object} options - Configuration options
     */
    constructor(sharedMemoryManager, options = {}) {
        this.shmManager = sharedMemoryManager;
        this.yieldInterval = options.yieldInterval || 100; // Yield every 100 objects
        this.maxDepth = options.maxDepth || 100; // Prevent stack overflow
        this.operationCount = 0; // Track operations for yielding
    }

    /**
     * Main entry point - sanitize message for worker thread communication
     * @param {object} msg - Message object to sanitize
     * @param {object} node - Node-RED node instance (for warnings)
     * @param {number|string} taskId - Task identifier for shared memory tracking
     * @returns {Promise<object>} Sanitized message object
     */
    async sanitizeMessage(msg, node, taskId) {
        if (!msg || typeof msg !== 'object') {
            return msg;
        }

        // Reset operation counter
        this.operationCount = 0;

        // Use WeakMap for circular tracking (allows storing replacement values)
        const seen = new WeakMap();
        const bufferIndex = { value: 0 }; // Mutable counter for buffer indexing

        try {
            return await this.cloneValue(msg, seen, 0, bufferIndex, taskId, node, '');
        } catch (err) {
            if (node) {
                node.warn(`Message cloning failed: ${err.message}, creating minimal message`);
            }
            return this.createMinimalMessage(msg);
        }
    }

    /**
     * Recursively clone a value with async operation and shared memory offloading
     * @param {*} value - Value to clone
     * @param {WeakMap} seen - Circular reference tracker
     * @param {number} depth - Current recursion depth
     * @param {object} bufferIndex - Mutable buffer index counter
     * @param {number|string} taskId - Task identifier
     * @param {object} node - Node-RED node instance
     * @param {string} path - Current property path (for warnings)
     * @returns {Promise<*>} Cloned value
     */
    async cloneValue(value, seen, depth, bufferIndex, taskId, node, path) {
        // Check depth limit to prevent stack overflow
        if (depth > this.maxDepth) {
            if (node) {
                node.warn(`Maximum depth (${this.maxDepth}) exceeded at '${path}', truncating`);
            }
            return '[Max Depth Exceeded]';
        }

        // Yield to event loop periodically
        this.operationCount++;
        if (this.operationCount % this.yieldInterval === 0) {
            await this.yieldToEventLoop();
        }

        // Handle null/undefined
        if (value === null || value === undefined) {
            return value;
        }

        // Handle primitives
        const type = typeof value;
        if (type === 'string' || type === 'number' || type === 'boolean') {
            return value;
        }

        // Skip functions
        if (type === 'function') {
            if (node) {
                node.warn(`Property '${path}' is a function and will be omitted`);
            }
            return undefined;
        }

        // Skip symbols
        if (type === 'symbol') {
            if (node) {
                node.warn(`Property '${path}' is a symbol and will be omitted`);
            }
            return undefined;
        }

        // Handle dates
        if (value instanceof Date) {
            return new Date(value);
        }

        // Handle buffers - OFFLOAD TO SHARED MEMORY IF LARGE
        if (Buffer.isBuffer(value)) {
            const threshold = this.shmManager.threshold;

            if (value.length > threshold) {
                // Large buffer - offload to shared memory
                try {
                    const descriptor = await this.shmManager.writeBuffer(value, taskId, bufferIndex.value++);
                    // If writeBuffer returns a descriptor object, use it; otherwise it fell back to inline buffer
                    return descriptor;
                } catch (err) {
                    if (node) {
                        node.warn(`Failed to offload buffer at '${path}': ${err.message}, using inline copy`);
                    }
                    return Buffer.from(value);
                }
            } else {
                // Small buffer - inline copy
                return Buffer.from(value);
            }
        }

        // Handle arrays
        if (Array.isArray(value)) {
            // Check for circular reference
            if (seen.has(value)) {
                if (node) {
                    node.warn(`Circular reference detected at '${path}'`);
                }
                return '[Circular]';
            }

            seen.set(value, true);

            const result = [];
            for (let i = 0; i < value.length; i++) {
                const clonedItem = await this.cloneValue(
                    value[i],
                    seen,
                    depth + 1,
                    bufferIndex,
                    taskId,
                    node,
                    `${path}[${i}]`
                );
                if (clonedItem !== undefined) {
                    result.push(clonedItem);
                }
            }

            return result;
        }

        // Handle objects
        if (type === 'object') {
            // Check for circular reference
            if (seen.has(value)) {
                if (node) {
                    node.warn(`Circular reference detected at '${path}'`);
                }
                return '[Circular]';
            }

            seen.set(value, true);

            const result = {};
            const entries = Object.entries(value);

            for (let i = 0; i < entries.length; i++) {
                const [key, val] = entries[i];
                const clonedVal = await this.cloneValue(
                    val,
                    seen,
                    depth + 1,
                    bufferIndex,
                    taskId,
                    node,
                    path ? `${path}.${key}` : key
                );
                if (clonedVal !== undefined) {
                    result[key] = clonedVal;
                }
            }

            return result;
        }

        // Unknown type
        if (node) {
            node.warn(`Property '${path}' has unknown type '${type}' and will be omitted`);
        }
        return undefined;
    }

    /**
     * Yield to event loop to prevent blocking
     * @returns {Promise<void>}
     */
    async yieldToEventLoop() {
        return new Promise(resolve => setImmediate(resolve));
    }

    /**
     * Restore buffers from shared memory descriptors (worker-side)
     * @param {*} value - Value to restore (may contain descriptors)
     * @returns {Promise<*>} Value with buffers restored
     */
    async restoreBuffers(value) {
        // Handle null/undefined
        if (value === null || value === undefined) {
            return value;
        }

        // Handle primitives
        const type = typeof value;
        if (type === 'string' || type === 'number' || type === 'boolean') {
            return value;
        }

        // Handle dates
        if (value instanceof Date) {
            return value;
        }

        // Handle buffers (already restored)
        if (Buffer.isBuffer(value)) {
            return value;
        }

        // Handle shared memory descriptor
        if (value && typeof value === 'object' && value.__rosepetal_shm_path__) {
            try {
                return await this.shmManager.readBuffer(value);
            } catch (err) {
                throw new Error(`Failed to restore buffer from shared memory: ${err.message}`);
            }
        }

        // Handle arrays
        if (Array.isArray(value)) {
            const result = [];
            for (const item of value) {
                result.push(await this.restoreBuffers(item));
            }
            return result;
        }

        // Handle objects
        if (type === 'object') {
            const result = {};
            for (const [key, val] of Object.entries(value)) {
                result[key] = await this.restoreBuffers(val);
            }
            return result;
        }

        return value;
    }

    /**
     * Create a minimal message for error cases
     * Preserves only essential properties
     * @param {object} msg - Original message
     * @returns {object} Minimal message
     */
    createMinimalMessage(msg) {
        return {
            _msgid: msg._msgid || '',
            topic: msg.topic || '',
            payload: msg.payload !== undefined ? msg.payload : null
        };
    }
}

/**
 * Legacy synchronous functions for backward compatibility
 * (used in tests or cases where SharedMemoryManager is not available)
 */

/**
 * Check if a value is serializable for worker thread communication
 * @param {*} value - Value to check
 * @returns {boolean} True if serializable
 */
function isSerializable(value) {
    if (value === null || value === undefined) {
        return true;
    }

    const type = typeof value;

    // Primitive types are serializable
    if (type === 'string' || type === 'number' || type === 'boolean') {
        return true;
    }

    // Functions are not serializable
    if (type === 'function') {
        return false;
    }

    // Symbols are not serializable
    if (type === 'symbol') {
        return false;
    }

    // Try to clone the value
    try {
        // Use structuredClone if available (Node.js 17+)
        if (typeof structuredClone !== 'undefined') {
            structuredClone(value);
            return true;
        }

        // Fallback: try JSON serialization
        JSON.stringify(value);
        return true;
    } catch (err) {
        return false;
    }
}

/**
 * Legacy synchronous sanitize function (for backward compatibility)
 * NOTE: This is kept for tests but should not be used in production
 * Use AsyncMessageSerializer instead
 *
 * @param {object} msg - Message object to sanitize
 * @param {object} node - Node-RED node instance (for warnings)
 * @returns {object} Sanitized message object
 */
function sanitizeMessage(msg, node) {
    if (!msg || typeof msg !== 'object') {
        return msg;
    }

    try {
        // Try structuredClone first (Node.js 17+)
        if (typeof structuredClone !== 'undefined') {
            return structuredClone(msg);
        }
    } catch (err) {
        // If structuredClone fails, fall through to manual filtering
        if (node) {
            node.warn('Message contains non-serializable data, filtering...');
        }
    }

    // Manual filtering for older Node.js versions or complex cases
    const cloned = {};
    const seen = new WeakSet();

    function cloneValue(value, path) {
        // Handle null/undefined
        if (value === null || value === undefined) {
            return value;
        }

        // Handle primitives
        const type = typeof value;
        if (type === 'string' || type === 'number' || type === 'boolean') {
            return value;
        }

        // Skip functions
        if (type === 'function') {
            if (node) {
                node.warn(`Property '${path}' is a function and will be omitted`);
            }
            return undefined;
        }

        // Skip symbols
        if (type === 'symbol') {
            if (node) {
                node.warn(`Property '${path}' is a symbol and will be omitted`);
            }
            return undefined;
        }

        // Handle dates
        if (value instanceof Date) {
            return new Date(value);
        }

        // Handle buffers
        if (Buffer.isBuffer(value)) {
            return Buffer.from(value);
        }

        // Handle arrays
        if (Array.isArray(value)) {
            return value.map((item, index) => cloneValue(item, `${path}[${index}]`));
        }

        // Handle objects
        if (type === 'object') {
            // Check for circular reference
            if (seen.has(value)) {
                if (node) {
                    node.warn(`Circular reference detected at '${path}'`);
                }
                return '[Circular]';
            }

            seen.add(value);

            const result = {};
            for (const [key, val] of Object.entries(value)) {
                const clonedVal = cloneValue(val, path ? `${path}.${key}` : key);
                if (clonedVal !== undefined) {
                    result[key] = clonedVal;
                }
            }

            return result;
        }

        // Unknown type
        if (node) {
            node.warn(`Property '${path}' has unknown type '${type}' and will be omitted`);
        }
        return undefined;
    }

    // Clone each property
    for (const [key, value] of Object.entries(msg)) {
        const clonedValue = cloneValue(value, key);
        if (clonedValue !== undefined) {
            cloned[key] = clonedValue;
        }
    }

    return cloned;
}

/**
 * Create a minimal message for error cases
 * Preserves only essential properties
 *
 * @param {object} msg - Original message
 * @returns {object} Minimal message
 */
function createMinimalMessage(msg) {
    return {
        _msgid: msg._msgid || '',
        topic: msg.topic || '',
        payload: msg.payload !== undefined ? msg.payload : null
    };
}

module.exports = {
    AsyncMessageSerializer,
    isSerializable,
    sanitizeMessage,
    createMinimalMessage
};
