/**
 * Module Installer
 *
 * Handles automatic installation of npm modules for the async-function node.
 * Modules are installed in the Node-RED user directory (~/.node-red).
 */

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Get the Node-RED user directory
 * @returns {string} Path to Node-RED user directory
 */
function getNodeRedUserDir() {
    // Check for explicit NODE_RED_HOME environment variable
    if (process.env.NODE_RED_HOME) {
        return process.env.NODE_RED_HOME;
    }

    // Default to ~/.node-red
    const defaultDir = path.join(os.homedir(), '.node-red');

    // Verify it exists
    if (fs.existsSync(defaultDir)) {
        return defaultDir;
    }

    // Fallback to home directory if .node-red doesn't exist
    return os.homedir();
}

/**
 * Install an npm module in the Node-RED user directory
 * @param {string} moduleName - Name of the module to install
 * @returns {boolean} True if installation succeeded
 */
function installModule(moduleName) {
    if (!moduleName || typeof moduleName !== 'string') {
        console.error('[async-function] Invalid module name');
        return false;
    }

    // Sanitize module name to prevent command injection
    const sanitizedName = moduleName.trim();
    if (!/^(@[\w-]+\/)?[\w.-]+(@[\w.-]+)?$/.test(sanitizedName)) {
        console.error(`[async-function] Invalid module name format: ${sanitizedName}`);
        return false;
    }

    const userDir = getNodeRedUserDir();

    try {
        console.log(`[async-function] Installing module: ${sanitizedName} in ${userDir}`);

        // Use spawnSync with array arguments to prevent command injection
        const result = spawnSync('npm', ['install', sanitizedName], {
            cwd: userDir,
            stdio: 'pipe',
            timeout: 120000,  // 2 minute timeout
            env: {
                ...process.env,
                npm_config_loglevel: 'error'
            }
        });

        if (result.error) {
            throw result.error;
        }

        if (result.status !== 0) {
            const stderr = result.stderr ? result.stderr.toString() : 'Unknown error';
            throw new Error(`npm install failed with code ${result.status}: ${stderr}`);
        }

        console.log(`[async-function] Successfully installed: ${sanitizedName}`);
        return true;

    } catch (err) {
        console.error(`[async-function] Failed to install ${sanitizedName}: ${err.message}`);
        return false;
    }
}

/**
 * Check if a module is available
 * @param {string} moduleName - Name of the module to check
 * @returns {boolean} True if module can be resolved
 */
function isModuleAvailable(moduleName) {
    try {
        require.resolve(moduleName);
        return true;
    } catch (err) {
        return false;
    }
}

module.exports = {
    installModule,
    isModuleAvailable,
    getNodeRedUserDir
};
