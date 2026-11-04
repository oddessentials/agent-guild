// A tool that never answers `mcp list`, and records its pid in the folder it was started in.
import fs from 'node:fs';
import path from 'node:path';

if (process.argv[2] !== 'mcp') process.exit(1);
fs.writeFileSync(path.join(process.cwd(), 'hung-mcp.pid'), String(process.pid));
setInterval(() => {}, 1000);
