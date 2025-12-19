/**
 * Shared Memory Manager
 *
 * Manages shared memory file lifecycle for large buffer transfer.
 * Handles writing buffers to /dev/shm (Linux) or os.tmpdir(), tracking attachments,
 * and cleanup coordination across task lifecycle.
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const SHARED_SENTINEL_KEY = '__rosepetal_shm_path__';
const SHARED_BASE64_KEY = '__rosepetal_base64__';

class SharedMemoryManager {
    /**
     * Create a shared memory manager
     * @param {object} options - Configuration options
     */
    constructor(options = {}) {
        this.threshold = options.threshold ?? 100 * 1024; // 100KB default
        this.shmPath = this.detectShmPath();
        this.trackAttachments = options.trackAttachments !== false;
        this.taskAttachments = new Map(); // taskId → Set<filePath>
        this.globalAttachments = new Set(); // All active files
        this.performanceMetrics = {
            totalBytes: 0,
            totalFiles: 0,
            filesCreated: 0,
            filesDeleted: 0
        };

        // Cleanup orphaned files from previous crashes
        if (options.cleanupOrphanedFiles !== false) {
            this.cleanupOrphanedFiles();
        }
    }

    /**
     * Detect platform-specific shared memory path
     * @returns {string} Path to shared memory directory
     */
    detectShmPath() {
        // Linux: /dev/shm (RAM-backed tmpfs)
        const shmPath = '/dev/shm';

        try {
            // Check if /dev/shm exists and is writable
            fsSync.accessSync(shmPath, fsSync.constants.W_OK);
            return shmPath;
        } catch (err) {
            // Fall back to os.tmpdir() (macOS, Windows, or Linux without /dev/shm)
            return os.tmpdir();
        }
    }

    /**
     * Generate unique collision-resistant filename
     * @param {number|string} taskId - Task identifier
     * @param {number} bufferIndex - Buffer index within message
     * @returns {string} Unique filename
     */
    generateFilename(taskId, bufferIndex) {
        const pid = process.pid;
        const timestamp = Date.now();
        const random = crypto.randomBytes(2).toString('hex');

        // Format: rosepetal-async-{pid}-{taskId}-{bufferIndex}-{timestamp}-{random}.bin
        return `rosepetal-async-${pid}-${taskId}-${bufferIndex}-${timestamp}-${random}.bin`;
    }

    /**
     * Write buffer to shared memory
     * @param {Buffer} buffer - Buffer to write
     * @param {number|string} taskId - Task identifier
     * @param {number} bufferIndex - Buffer index within message
     * @returns {Promise<object>} Descriptor object
     */
    async writeBuffer(buffer, taskId, bufferIndex) {
        // Check if buffer exceeds threshold
        if (this.threshold > 0 && buffer.length <= this.threshold) {
            // Return inline buffer (no shared memory needed)
            return buffer;
        }

        try {
            const filename = this.generateFilename(taskId, bufferIndex);
            const filePath = path.join(this.shmPath, filename);

            // Write buffer to file asynchronously
            await fs.writeFile(filePath, buffer);

            // Track attachment
            this.trackAttachment(taskId, filePath);

            // Update metrics
            this.performanceMetrics.totalBytes += buffer.length;
            this.performanceMetrics.totalFiles++;
            this.performanceMetrics.filesCreated++;

            // Return descriptor
            return {
                [SHARED_SENTINEL_KEY]: filePath,
                length: buffer.length
            };

        } catch (err) {
            // Fallback to base64 (slower, but keeps payload serializable)
            try {
                return {
                    [SHARED_BASE64_KEY]: buffer.toString('base64'),
                    length: buffer.length
                };
            } catch (_encodeErr) {
                // Last resort: inline buffer
                return buffer;
            }
        }
    }

    /**
     * Read buffer from shared memory
     * @param {object} descriptor - Buffer descriptor
     * @returns {Promise<Buffer>} Buffer contents
     */
    async readBuffer(descriptor, options = {}) {
        // Validate descriptor
        if (!descriptor || typeof descriptor !== 'object') {
            throw new Error('Invalid descriptor: must be an object');
        }

        if (!descriptor[SHARED_SENTINEL_KEY]) {
            throw new Error(`Invalid descriptor: missing ${SHARED_SENTINEL_KEY}`);
        }

        const filePath = descriptor[SHARED_SENTINEL_KEY];

        try {
            // Read file asynchronously
            const buffer = await fs.readFile(filePath);

            // Validate length
            if (descriptor.length && buffer.length !== descriptor.length) {
                console.warn(`Buffer length mismatch: expected ${descriptor.length}, got ${buffer.length}`);
            }

            if (options.deleteAfterRead) {
                await fs.unlink(filePath).catch(unlinkErr => {
                    if (unlinkErr.code !== 'ENOENT') {
                        console.warn(`Failed to unlink shared memory file ${filePath}: ${unlinkErr.message}`);
                    }
                });
            }

            return buffer;

        } catch (err) {
            if (err.code === 'ENOENT') {
                throw new Error(`Shared memory file not found: ${filePath}. File may have been cleaned up prematurely.`);
            }
            throw new Error(`Failed to read buffer from shared memory: ${err.message}`);
        }
    }

    /**
     * Track attachment for task
     * @param {number|string} taskId - Task identifier
     * @param {string} filePath - File path to track
     */
    trackAttachment(taskId, filePath) {
        if (!this.trackAttachments) {
            return;
        }

        // Create task attachment set if doesn't exist
        if (!this.taskAttachments.has(taskId)) {
            this.taskAttachments.set(taskId, new Set());
        }

        // Add to task-specific set
        this.taskAttachments.get(taskId).add(filePath);

        // Add to global set
        this.globalAttachments.add(filePath);
    }

    /**
     * Cleanup task attachments
     * @param {number|string} taskId - Task identifier
     * @returns {Promise<void>}
     */
    async cleanupTask(taskId) {
        const attachments = this.taskAttachments.get(taskId);

        if (!attachments || attachments.size === 0) {
            return; // Nothing to cleanup
        }

        // Delete all files for this task
        const deletePromises = [];
        for (const filePath of attachments) {
            deletePromises.push(
                fs.unlink(filePath)
                    .then(() => {
                        this.globalAttachments.delete(filePath);
                        this.performanceMetrics.totalFiles = Math.max(0, this.performanceMetrics.totalFiles - 1);
                        this.performanceMetrics.filesDeleted++;
                    })
                    .catch(err => {
                        if (err.code === 'ENOENT') {
                            // File already cleaned up (e.g. worker deleted after read)
                            this.globalAttachments.delete(filePath);
                            this.performanceMetrics.totalFiles = Math.max(0, this.performanceMetrics.totalFiles - 1);
                            this.performanceMetrics.filesDeleted++;
                            return;
                        }

                        console.warn(`Failed to cleanup file ${filePath}: ${err.message}`);
                    })
            );
        }

        await Promise.all(deletePromises);

        // Remove task entry
        this.taskAttachments.delete(taskId);
    }

    /**
     * Cleanup all attachments (shutdown)
     * @returns {Promise<void>}
     */
    async cleanupAll() {
        // Delete all tracked files
        const deletePromises = [];
        for (const filePath of this.globalAttachments) {
            deletePromises.push(
                fs.unlink(filePath).catch(err => {
                    if (err.code !== 'ENOENT') {
                        console.warn(`Failed to cleanup file ${filePath}: ${err.message}`);
                    }
                })
            );
        }

        await Promise.all(deletePromises);

        // Clear all maps
        this.taskAttachments.clear();
        this.globalAttachments.clear();

        // Reset metrics
        this.performanceMetrics.totalFiles = 0;
    }

    /**
     * Cleanup orphaned files from previous crashes
     */
    cleanupOrphanedFiles() {
        const pattern = `rosepetal-async-${process.pid}-`;
        const oneHourAgo = Date.now() - (60 * 60 * 1000);

        try {
            const files = fsSync.readdirSync(this.shmPath);

            for (const file of files) {
                // Skip files that don't match our pattern
                if (!file.startsWith('rosepetal-async-')) {
                    continue;
                }

                const filePath = path.join(this.shmPath, file);

                try {
                    const stats = fsSync.statSync(filePath);

                    // Only cleanup files older than 1 hour
                    if (stats.mtimeMs < oneHourAgo) {
                        fsSync.unlinkSync(filePath);
                        console.log(`Cleaned up orphaned file: ${file}`);
                    }
                } catch (err) {
                    // Ignore errors for individual files
                }
            }
        } catch (err) {
            // Ignore errors during startup cleanup
            console.warn(`Failed to cleanup orphaned files: ${err.message}`);
        }
    }

    /**
     * Get statistics
     * @returns {object} Statistics object
     */
    getStats() {
        return {
            activeTasks: this.taskAttachments.size,
            activeFiles: this.globalAttachments.size,
            threshold: this.threshold,
            shmPath: this.shmPath,
            ...this.performanceMetrics
        };
    }
}

module.exports = {
    SharedMemoryManager
};
