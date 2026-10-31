// The manager, writing its own output to manager.log rather than to handles it was given.
import fs from 'node:fs';
import path from 'node:path';
import { startManager } from '../../src/manager/main.mjs';

const log = fs.openSync(path.join(process.env.AGENT_GUILD_HOME, 'manager.log'), 'a');
for (const stream of [process.stdout, process.stderr]) stream.write = (chunk) => { fs.writeSync(log, chunk); return true; };
startManager().then(({ shutdown }) => {
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig).then(() => process.exit(0)));
}).catch((err) => {
  console.error(`[manager] failed to start: ${err.message}`);
  process.exit(1);
});
