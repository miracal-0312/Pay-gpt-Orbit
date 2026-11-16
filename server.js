'use strict';

// Keep the established Node/Docker entry point while the implementation lives in src/.
const server = require('./src/server');
if (require.main === module) server.run();
module.exports = server;
