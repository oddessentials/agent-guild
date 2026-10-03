// Stands in for a multiplexer client that starts the multiplexer's server,
// as herdr's does: the server is the client's child, detached, and must
// outlive the client. Writes the server's pid to the file named first.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore', windowsHide: true });
server.unref();
fs.writeFileSync(process.argv[2], String(server.pid));
process.stdout.write('FAKE-MULTIPLEXER READY\r\n');
setInterval(() => {}, 1 << 30);
