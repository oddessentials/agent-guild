import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'installers', 'node.json');
export const TARGETS = ['win-x64', 'win-arm64', 'linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];

export const archiveName = (version, target) => `node-v${version}-${target}.${target.startsWith('win-') ? 'zip' : 'tar.gz'}`;
export const archiveUrl = (version, target) => `https://nodejs.org/dist/v${version}/${archiveName(version, target)}`;

export function pinsFrom(version, shasums) {
  const sums = new Map(shasums.split('\n').filter((line) => line.trim()).map((line) => line.trim().split(/\s+/).reverse()));
  const archives = {};
  for (const target of TARGETS) {
    const sha = sums.get(archiveName(version, target));
    if (!/^[0-9a-f]{64}$/.test(sha ?? '')) throw new Error(`SHASUMS256.txt for ${version} has no ${archiveName(version, target)}`);
    archives[target] = sha;
  }
  return { version, archives };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('Usage: node scripts/node-pins.mjs <Node.js version, as 24.22.2>');
    process.exit(2);
  }
  const res = await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`);
  if (!res.ok) throw new Error(`nodejs.org answered ${res.status} for ${version}'s SHASUMS256.txt`);
  fs.writeFileSync(PINS, `${JSON.stringify(pinsFrom(version, await res.text()), null, 2)}\n`);
}
