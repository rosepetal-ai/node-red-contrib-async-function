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

class SharedMemoryManager {
    /**
     * Create a shared memory manager
     * @param {object} options - Configuration options
     */
    constructor(options = {}) {
        this.threshold = options.threshold || 100 * 1024; // 100KB default
        this.shmPath = this.detectShmPath();
        this.taskAttachments = new Map(); // taskId → Set<filePath>
        this.globalAttachments = new Set(); // All active files
        this.performanceMetrics = {
            totalBytes: 0,
            totalFiles: 0,
            filesCreated: 0,
            filesDeleted: 0
        };

        // Cleanup orphaned files from previous crashes
        this.cleanupOrphanedFiles();
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
        if (buffer.length <= this.threshold) {
            // Return inline buffer (no shared memory needed)
            return Buffer.from(buffer);
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
                __rosepetal_shm_path__: filePath,
                length: buffer.length
            };

        } catch (err) {
            // Graceful fallback on error
            if (err.code === 'ENOSPC') {
                console.warn(`Shared memory full (ENOSPC), falling back to inline buffer for task ${taskId}`);
                return Buffer.from(buffer); // Return inline copy
            } else if (err.code === 'EACCES') {
                console.error(`Shared memory permission denied (EACCES), falling back to inline buffer for task ${taskId}`);
                return Buffer.from(buffer); // Return inline copy
            }
            // Rethrow other errors
            throw new Error(`Failed to write buffer to shared memory: ${err.message}`);
        }
    }

    /**
     * Read buffer from shared memory
     * @param {object} descriptor - Buffer descriptor
     * @returns {Promise<Buffer>} Buffer contents
     */
    async readBuffer(descriptor) {
        // Validate descriptor
        if (!descriptor || typeof descriptor !== 'object') {
            throw new Error('Invalid descriptor: must be an object');
        }

        if (!descriptor.__rosepetal_shm_path__) {
            throw new Error('Invalid descriptor: missing __rosepetal_shm_path__');
        }

        const filePath = descriptor.__rosepetal_shm_path__;

        try {
            // Read file asynchronously
            const buffer = await fs.readFile(filePath);

            // Validate length
            if (descriptor.length && buffer.length !== descriptor.length) {
                console.warn(`Buffer length mismatch: expected ${descriptor.length}, got ${buffer.length}`);
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
                        this.performanceMetrics.totalFiles--;
                        this.performanceMetrics.filesDeleted++;
                    })
                    .catch(err => {
                        // Log but don't fail
                        if (err.code !== 'ENOENT') {
                            console.warn(`Failed to cleanup file ${filePath}: ${err.message}`);
                        }
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
