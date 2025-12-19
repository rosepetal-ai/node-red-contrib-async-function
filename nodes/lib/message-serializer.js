/**
 * Async Message Serializer
 *
 * Fast message cloning for worker thread communication.
 * Matches the shared-memory + msg-copy semantics used by the python executor "hot mode":
 * - Buffers (and typed arrays) can be offloaded to shared memory with descriptors
 * - Base64 fallback for shared-memory failures
 * - Circular references preserved via WeakMap
 */

const SHARED_SENTINEL_KEY = '__rosepetal_shm_path__';
const SHARED_BASE64_KEY = '__rosepetal_base64__';

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
        this.maxDepth = options.maxDepth || 0;
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

        const seen = new WeakMap();
        const bufferIndex = { value: 0 }; // Mutable counter for buffer indexing

        try {
            return await this.cloneValue(msg, seen, bufferIndex, taskId, 0);
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
    async cloneValue(value, seen, bufferIndex, taskId, depth) {
        // Optional depth guard (disabled by default for speed)
        if (this.maxDepth > 0 && depth > this.maxDepth) {
            return null;
        }

        if (value === null || value === undefined) {
            return value;
        }

        // Handle primitives
        const type = typeof value;
        if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
            return value;
        }

        // Drop non-cloneable types
        if (type === 'function' || type === 'symbol') {
            return undefined;
        }

        // Buffers + typed arrays: offload to shared memory when above threshold
        if (Buffer.isBuffer(value)) {
            return await this.shmManager.writeBuffer(value, taskId, bufferIndex.value++);
        }

        if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
            const asBuffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            return await this.shmManager.writeBuffer(asBuffer, taskId, bufferIndex.value++);
        }

        if (type === 'object') {
            // Preserve circular references
            if (seen.has(value)) {
                return seen.get(value);
            }

            const clone = Array.isArray(value) ? [] : {};
            seen.set(value, clone);

            if (Array.isArray(value)) {
                for (let i = 0; i < value.length; i++) {
                    const clonedItem = await this.cloneValue(value[i], seen, bufferIndex, taskId, depth + 1);
                    clone[i] = clonedItem === undefined ? null : clonedItem;
                }
                return clone;
            }

            const keys = Object.keys(value);
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                const clonedVal = await this.cloneValue(value[key], seen, bufferIndex, taskId, depth + 1);
                if (clonedVal !== undefined) {
                    clone[key] = clonedVal;
                }
            }

            return clone;
        }

        return undefined;
    }

    /**
     * Restore buffers from shared memory descriptors (worker-side)
     * @param {*} value - Value to restore (may contain descriptors)
     * @returns {Promise<*>} Value with buffers restored
     */
    async restoreBuffers(value) {
        const seen = new WeakMap();
        return this.restoreValue(value, seen);
    }

    async restoreValue(value, seen) {
        // Handle null/undefined
        if (value === null || value === undefined) {
            return value;
        }

        // Handle primitives
        const type = typeof value;
        if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') {
            return value;
        }

        // Handle buffers (already restored)
        if (Buffer.isBuffer(value)) {
            return value;
        }

        // Handle arrays
        if (Array.isArray(value)) {
            if (seen.has(value)) {
                return seen.get(value);
            }

            const result = new Array(value.length);
            seen.set(value, result);

            for (let i = 0; i < value.length; i++) {
                result[i] = await this.restoreValue(value[i], seen);
            }

            return result;
        }

        // Handle objects
        if (type === 'object') {
            // Shared memory descriptor
            if (Object.prototype.hasOwnProperty.call(value, SHARED_SENTINEL_KEY)) {
                try {
                    return await this.shmManager.readBuffer(value, { deleteAfterRead: true });
                } catch (_err) {
                    return Buffer.alloc(0);
                }
            }

            // Base64 fallback
            if (Object.prototype.hasOwnProperty.call(value, SHARED_BASE64_KEY)) {
                try {
                    return Buffer.from(value[SHARED_BASE64_KEY] || '', 'base64');
                } catch (_err) {
                    return Buffer.alloc(0);
                }
            }

            if (seen.has(value)) {
                return seen.get(value);
            }

            const result = {};
            seen.set(value, result);

            const entries = Object.entries(value);
            for (let i = 0; i < entries.length; i++) {
                const [key, val] = entries[i];
                result[key] = await this.restoreValue(val, seen);
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
