import { startDaemon } from './server.js';
import { preflight } from './preflight.js';
const operation = process.argv.includes('--preflight') ? preflight() : startDaemon();
operation.catch((e) => {
  process.stderr.write(`cmdr daemon: ${e.message}\n`);
  process.exitCode = 1;
});
