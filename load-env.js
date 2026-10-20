'use strict';

const path = require('node:path');

// Load before importing modules that capture environment values at startup.
// Docker / system environment values take precedence over the local file.
function loadEnv(file = path.join(__dirname, '.env')) {
    try {
        process.loadEnvFile(file);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        // Do not include file contents or secret values in startup errors.
        throw new Error(`Cannot load environment file (${error.code || 'unknown error'}).`);
    }
}

module.exports = loadEnv;
