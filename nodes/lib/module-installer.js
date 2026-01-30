/**
 * Module Installer
 *
 * Handles automatic installation of npm modules for the async-function node.
 * Modules are installed in the Node-RED user directory (~/.node-red).
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs').promises;
const { constants: fsConstants } = require('fs');

/**
 * Get the Node-RED user directory
 * @returns {Promise<string>} Path to Node-RED user directory
 */
async function getNodeRedUserDir() {
    // Check for explicit NODE_RED_HOME environment variable
    if (process.env.NODE_RED_HOME) {
        return process.env.NODE_RED_HOME;
    }

    // Default to ~/.node-red
    const defaultDir = path.join(os.homedir(), '.node-red');

    // Verify it exists
    try {
        await fs.access(defaultDir, fsConstants.F_OK);
        return defaultDir;
    } catch (_err) {
        // Ignore access errors
    }

    // Fallback to home directory if .node-red doesn't exist
    return os.homedir();
}

/**
 * Install an npm module in the Node-RED user directory
 * @param {string} moduleName - Name of the module to install
 * @returns {Promise<boolean>} True if installation succeeded
 */
async function installModule(moduleName) {
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

    const userDir = await getNodeRedUserDir();

    try {
        console.log(`[async-function] Installing module: ${sanitizedName} in ${userDir}`);

        await new Promise((resolve, reject) => {
            const child = spawn('npm', ['install', sanitizedName], {
                cwd: userDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: {
                    ...process.env,
                    npm_config_loglevel: 'error'
                }
            });

            let stderr = '';
            if (child.stderr) {
                child.stderr.on('data', (chunk) => {
                    stderr += chunk.toString();
                });
            }

            const timeout = setTimeout(() => {
                if (!child.killed) {
                    child.kill();
                }
                reject(new Error('npm install timed out'));
            }, 120000);

            child.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            child.on('close', (code) => {
                clearTimeout(timeout);
                if (code === 0) {
                    resolve();
                    return;
                }
                reject(new Error(`npm install failed with code ${code}: ${stderr || 'Unknown error'}`));
            });
        });

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
