/**
 * Async Function Node
 *
 * A Node-RED function node that executes user code in worker threads
 * to prevent event loop blocking.
 */

const { getGlobalPool, shutdownGlobalPool } = require('./lib/worker-pool');
const { sanitizeMessage } = require('./lib/message-serializer');

/**
 * Update node status with pool statistics
 */
function updateStatus(node) {
    if (!node.pool) return;

    const stats = node.pool.getStats();

    // Format: "Active: 2/4 | Queue: 5"
    const statusText = `Active: ${stats.busyWorkers}/${stats.totalWorkers} | Queue: ${stats.queuedTasks}`;

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

        // Get worker pool (global singleton)
        try {
            node.pool = getGlobalPool({
                minWorkers: config.minWorkers || 2,
                maxWorkers: config.maxWorkers || 4,
                maxQueueSize: config.maxQueueSize || 100,
                taskTimeout: node.timeout
            });
        } catch (err) {
            node.error('Failed to initialize worker pool: ' + err.message);
            node.status({
                fill: 'red',
                shape: 'dot',
                text: 'Pool init failed'
            });
            return;
        }

        // Initialize pool
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

        // Handle incoming messages
        node.on('input', async function(msg, send, done) {
            // Backwards compatibility with older Node-RED versions
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) {
                if (err) {
                    node.error(err, msg);
                }
            };

            try {
                // Sanitize message for worker thread
                const clonedMsg = sanitizeMessage(msg, node);

                // Execute in worker pool
                const result = await node.pool.executeTask(
                    node.func,
                    clonedMsg,
                    node.timeout
                );

                // Handle result
                if (result === null || result === undefined) {
                    // No output
                    done();
                } else if (Array.isArray(result)) {
                    // Multiple outputs
                    send(result);
                    done();
                } else {
                    // Single output
                    send(result);
                    done();
                }

                // Update status
                updateStatus(node);

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

                // Restore normal status after 3 seconds
                setTimeout(() => {
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

            node.status({});

            // Note: We don't shutdown the global pool here since other nodes may be using it
            // The pool will be shut down when Node-RED shuts down

            if (done) {
                done();
            }
        });
    }

    // Register the node type
    RED.nodes.registerType('async-function', AsyncFunctionNode);

    // Cleanup on Node-RED shutdown
    RED.events.on('runtime-event', (event) => {
        if (event.id === 'runtime-stopped') {
            shutdownGlobalPool().catch(err => {
                console.error('Error shutting down worker pool:', err);
            });
        }
    });
};
