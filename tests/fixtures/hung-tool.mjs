// Stands in for a provider's command and notes each run in HUNG_TOOL_LOG. It never answers, except that with
// HUNG_TOOL_ANSWERS it ends a Codex hooks probe with an answer and exits on anything else. Like Codex's launcher, that
// app-server has a child of its own in the same folder.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const kind = args.includes('app-server') ? 'app-server' : args.includes('--version') || args.includes('version') ? 'version' : args.includes('--help') ? 'help' : args[0];
const note = (extra) => fs.appendFileSync(process.env.HUNG_TOOL_LOG, `${JSON.stringify({ pid: process.pid, kind, ...extra })}\n`);
note();
if (process.env.HUNG_TOOL_ANSWERS && kind !== 'app-server') process.exit(1);
setInterval(() => {}, 1000);
if (process.env.HUNG_TOOL_ANSWERS) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  note({ pid: child.pid, kind: 'app-server child' });
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const { id } = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      if (id === 1) process.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
      if (id === 2) {
        process.stdout.write(`${JSON.stringify({ id: 2, result: { data: [] } })}\n`);
        note({ answered: true });
      }
    }
  });
}
