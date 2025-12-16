/**
 * Message Serializer
 *
 * Safely clones messages for worker thread communication.
 * Handles non-serializable properties, circular references, and special types.
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
 * Sanitize a message object for worker thread communication
 * Removes non-serializable properties and handles special cases
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
    isSerializable,
    sanitizeMessage,
    createMinimalMessage
};
