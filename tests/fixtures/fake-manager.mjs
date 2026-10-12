// A stand-in session manager in a process of its own, so the launcher can wait for it to exit.
//   node fake-manager.mjs <home> <version> [slow]
// Answers health with its own pid and writes <home>/manager.json, which goes when a shutdown is requested. It then
// exits at once, or with `slow` 2 s later, answering no health check meanwhile, as a manager busy ending sessions.
// Prints its port once listening.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const [home, version, mode] = process.argv.slice(2);
const runtime = path.join(home, 'manager.json');
let stopping = false;
const server = http.createServer((req, res) => {
  if (req.url === '/api/v1/shutdown') {
    stopping = true;
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, running: 0 }));
    fs.rmSync(runtime, { force: true });
    if (mode === 'slow') setTimeout(() => process.exit(0), 2000);
    else setImmediate(() => { server.closeAllConnections(); server.close(() => process.exit(0)); });
    return;
  }
  if (stopping) return;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, name: 'agent-guild', version, pid: process.pid }));
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(runtime, JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}` }));
  process.stdout.write(`${port}\n`);
});
