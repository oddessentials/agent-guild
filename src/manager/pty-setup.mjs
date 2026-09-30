// Work around a node-pty 1.1.0 packaging problem on macOS.
//
// The published package stores prebuilds/darwin-*/spawn-helper without its
// executable bit, so every spawn fails with "posix_spawnp failed". Restore
// the bit once, before the first terminal starts.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let checked = false;

export function spawnHelperCandidates(ptyDir, arch = process.arch) {
  return [
    path.join(ptyDir, 'prebuilds', `darwin-${arch}`, 'spawn-helper'),
    path.join(ptyDir, 'build', 'Release', 'spawn-helper'),
  ];
}

/** Make node-pty's spawn helper executable on macOS. Safe to call repeatedly. */
export function ensurePtyReady({ platform = process.platform, ptyDir } = {}) {
  if (checked || platform !== 'darwin') return;
  checked = true;
  const dir = ptyDir || path.dirname(require.resolve('node-pty/package.json'));
  for (const helper of spawnHelperCandidates(dir)) {
    let stat;
    try { stat = fs.statSync(helper); } catch { continue; }
    if ((stat.mode & 0o111) === 0o111) continue;
    try {
      fs.chmodSync(helper, stat.mode | 0o755);
    } catch (err) {
      console.warn(`[pty] ${helper} is not executable and could not be fixed (${err.code}). ` +
        `Terminals will fail to start. Run: chmod +x "${helper}"`);
    }
  }
}
