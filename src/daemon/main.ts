import { startDaemon } from './server.js';
startDaemon().catch((e) => {
  process.stderr.write(`cmdr daemon: ${e.message}\n`);
  process.exitCode = 1;
});
