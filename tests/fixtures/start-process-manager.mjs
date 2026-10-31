// Starts own-log-manager.mjs through Windows PowerShell's Start-Process and prints the new process's pid.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const quote = (text) => `'${text.replace(/'/g, "''")}'`;
const script = `$p = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote(`"${path.join(here, 'own-log-manager.mjs')}"`)} -WindowStyle Hidden -PassThru; $p.Id`;
const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
if (result.error || result.status !== 0) {
  console.error(result.error?.message || result.stderr);
  process.exit(1);
}
console.log(result.stdout.trim());
