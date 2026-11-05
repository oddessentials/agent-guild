import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSpawnSpec } from './command-resolver.mjs';

export const COMPANION_RUNNER = fileURLToPath(import.meta.url);
export const WINDOWS_PUBLISHER = 'CN=Peter Palles, O=Peter Palles, L=Pottsville, S=pa, C=US';
export const MACOS_TEAM = 'H3FY62W58W';
const RELEASES = 'https://github.com/oddessentials/agent-guild-companions/releases';
const INSTALLERS = { win32: 'Grove-Companion-windows-setup.exe', darwin: 'Grove-Companion-macos.dmg' };
const APP = 'Grove Companion.app';
const BUNDLE_ID = 'com.oddessentials.agentguild.companion';
const TRANSACTION = '.grove-companion-install';
// Darwin's O_EXLOCK is not exposed by Node's fs.constants.
const MACOS_EXCLUSIVE_LOCK = 0x20;

export const companionSupported = (platform) => Object.hasOwn(INSTALLERS, platform);

export function companionSpawnSpec(env, platform) {
  return buildSpawnSpec(process.execPath, [COMPANION_RUNNER], env, platform);
}

const refuse = (message) => Object.assign(new Error(message), { refused: true });
const output = (result) => `${result.stdout || ''}${result.stderr || ''}`;
const runCommand = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', ...options });
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const entry = (file) => fs.lstatSync(file, { throwIfNoEntry: false });

function cleanup(file, log) {
  try { fs.rmSync(file, { recursive: true, force: true }); }
  catch (err) { log(`Could not clean up ${file}: ${err.message}`); }
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function latestRelease(fetchImpl) {
  const response = await fetchImpl(`${RELEASES}/latest`, { method: 'HEAD', redirect: 'follow' });
  const tag = /\/releases\/tag\/(v\d+\.\d+\.\d+)$/.exec(response.url || '')?.[1];
  if (!response.ok || !tag) throw refuse('Could not find the latest Grove Companion release.');
  return tag;
}

async function download(fetchImpl, tag, name) {
  const response = await fetchImpl(`${RELEASES}/download/${tag}/${name}`, { redirect: 'follow' });
  if (!response.ok) throw refuse(`Could not download ${name} from ${tag} (HTTP ${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

function listedHash(sums, name) {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match?.[2] === name) return match[1];
  }
  return null;
}

function installWindows(file, { env, run, log }) {
  const powershell = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replaceAll("'", "''")}'; @{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject; timestamped = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress`;
  const result = run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  let signature = null;
  try { signature = JSON.parse(result.stdout); } catch {}
  if (signature?.status !== 'Valid' || !signature.timestamped || signature.subject !== WINDOWS_PUBLISHER) {
    throw refuse(`The installer is not signed and timestamped by ${WINDOWS_PUBLISHER} (${signature ? `${signature.status}, ${signature.subject || 'no signer'}` : 'no signature read'}), so it was not run.`);
  }
  log('Installing, then starting the Grove Companion…');
  const install = run(file, ['/S', '/R']);
  if (install.status !== 0) throw refuse(`The installer exited with code ${install.status}.`);
}

function verifyMac(app, run, notarized = false) {
  if (!entry(app)?.isDirectory()) throw refuse(`${app} is not a Grove Companion app bundle.`);
  if (run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]).status !== 0) throw refuse('The app’s signature does not verify, so it was not installed.');
  const details = run('/usr/bin/codesign', ['-dv', app]);
  const team = /^TeamIdentifier=(\S+)$/m.exec(output(details))?.[1];
  const id = /^Identifier=(\S+)$/m.exec(output(details))?.[1];
  if (details.status !== 0 || team !== MACOS_TEAM) throw refuse(`The app is signed by team ${team || 'none'}, not ${MACOS_TEAM}, so it was not installed.`);
  if (id !== BUNDLE_ID) throw refuse(`${app} is not the Grove Companion, so it was not replaced or installed.`);
  if (notarized) {
    const assess = run('/usr/sbin/spctl', ['--assess', '--type', 'exec', '-vv', app]);
    if (assess.status !== 0 || !/source=Notarized Developer ID/.test(output(assess))) throw refuse('macOS does not accept the app as notarized, so it was not installed.');
  }
}

function verifies(app, run) {
  try {
    verifyMac(app, run);
    return true;
  } catch {
    return false;
  }
}

function installedCompanion(app, run, repairing) {
  const read = entry(app)?.isDirectory() && run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')]);
  const id = read && read.status === 0 ? read.stdout.trim() : null;
  if (id === BUNDLE_ID || (repairing && id === null && entry(app)?.isDirectory())) return;
  throw refuse(`${app} is not the Grove Companion, so it was left unchanged. Move it out of the way and try again.`);
}

function macFolder(home, applications, writable) {
  const folders = [...new Set([applications, path.join(home, 'Applications')])];
  const installed = folders.filter((folder) => entry(path.join(folder, APP)) || entry(path.join(folder, TRANSACTION, 'previous.app')));
  if (installed.length > 1) throw refuse('Grove Companion installations exist in both Applications folders. Keep one installation before trying again.');
  const folder = installed[0] || (writable(applications) ? applications : path.join(home, 'Applications'));
  if (entry(folder) && (!entry(folder).isDirectory() || !writable(folder))) throw refuse(`Cannot replace the Grove Companion in ${folder}. Check its permissions before trying again.`);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

function lockMac(folder) {
  const file = path.join(folder, '.grove-companion-install.lock');
  try {
    return fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | MACOS_EXCLUSIVE_LOCK, 0o644);
  } catch (err) {
    if (['EAGAIN', 'EWOULDBLOCK'].includes(err.code)) throw refuse('The Grove Companion is already being installed. Try again when it finishes.');
    throw refuse(`Could not lock the Grove Companion installation in ${folder}: ${err.message}`);
  }
}

function recoverMac(target, work, run, log) {
  if (!entry(work)) return;
  if (!entry(work).isDirectory() || fs.readdirSync(work).some((name) => !name.startsWith('.') && !['staged.app', 'previous.app', 'discard'].includes(name))) {
    throw refuse(`Unrecognized installation files in ${work}. They were left unchanged.`);
  }
  for (const scratch of ['staged.app', 'discard']) fs.rmSync(path.join(work, scratch), { recursive: true, force: true });
  const previous = path.join(work, 'previous.app');
  if (entry(previous)) {
    if (!entry(target)) {
      installedCompanion(previous, run, true);
      fs.renameSync(previous, target);
      log('Restored the previous Grove Companion after an interrupted installation.');
    } else if (verifies(target, run)) {
      fs.rmSync(previous, { recursive: true });
    } else {
      return;
    }
  }
  fs.rmSync(work, { recursive: true });
}

function quitMac(target, run, wait, now) {
  const pattern = '^' + (target + '/Contents/MacOS/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const check = (file, signal = []) => {
    const result = run(file, [...signal, '-f', pattern]);
    if (result.error || ![0, 1].includes(result.status)) throw refuse('Could not confirm that the Grove Companion has stopped. Quit it and try again.');
    return result.status;
  };
  const stopped = () => {
    const deadline = now() + 5000;
    while (check('/usr/bin/pgrep') === 0) {
      const remaining = deadline - now();
      if (remaining <= 0) return false;
      wait(Math.min(100, remaining));
    }
    return true;
  };
  check('/usr/bin/pkill');
  if (stopped()) return;
  check('/usr/bin/pkill', ['-KILL']);
  if (!stopped()) throw refuse('The Grove Companion is still running. Quit it and try again; the existing app was not replaced.');
}

function replaceMac(app, folder, { run, log, wait, now }) {
  const target = path.join(folder, APP);
  const work = path.join(folder, TRANSACTION);
  const staged = path.join(work, 'staged.app');
  const previous = path.join(work, 'previous.app');
  const discard = path.join(work, 'discard');
  const repairing = Boolean(entry(previous));
  if (entry(target)) installedCompanion(target, run, repairing);
  fs.mkdirSync(work, { recursive: true });
  let committed = false, quit = false;
  try {
    log(`Copying the Grove Companion to ${folder}…`);
    if (run('/usr/bin/ditto', [app, staged]).status !== 0) throw refuse(`Could not copy the app to ${folder}.`);
    verifyMac(staged, run, true);
    quitMac(target, run, wait, now);
    quit = true;
    if (entry(target)) {
      if (repairing) {
        fs.mkdirSync(discard, { recursive: true });
        fs.renameSync(target, path.join(discard, APP));
      } else {
        fs.renameSync(target, previous);
      }
    }
    try { fs.renameSync(staged, target); }
    catch (err) {
      if (entry(previous)) {
        try { fs.renameSync(previous, target); }
        catch { throw refuse(`Could not replace or restore the Grove Companion. The previous app is preserved at ${previous}.`); }
      }
      throw err;
    }
    committed = true;
  } finally {
    if (!committed) {
      cleanup(staged, log);
      cleanup(discard, log);
      if (quit && entry(target)) run('/usr/bin/open', [target]);
      if (!entry(previous)) cleanup(work, log);
    }
  }
  cleanup(work, log);
  if (run('/usr/bin/open', [target]).status !== 0) throw refuse('The Grove Companion was installed but could not be started.');
}

function installMac(image, { workspace, folder, run, log, wait, now }) {
  const mount = path.join(workspace.dir, 'image');
  fs.mkdirSync(mount);
  const attach = run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, image]);
  if (attach.status !== 0) throw refuse(`Could not open the disk image (hdiutil exited with code ${attach.status}).`);
  workspace.mounted = true;
  try {
    const app = path.join(mount, APP);
    verifyMac(app, run, true);
    replaceMac(app, folder, { run, log, wait, now });
  } finally {
    try {
      workspace.mounted = run('/usr/bin/hdiutil', ['detach', mount]).status !== 0
        && run('/usr/bin/hdiutil', ['detach', '-force', mount]).status !== 0;
    } catch {}
    if (workspace.mounted) log(`Could not detach the disk image. Temporary files were kept at ${workspace.dir}.`);
  }
}

export async function installCompanion({
  platform = process.platform, env = process.env, fetch: fetchImpl = globalThis.fetch, run = runCommand, log = console.log,
  home = os.homedir(), tmp = os.tmpdir(), applications = '/Applications', writable = isWritable, wait = sleep, now = () => performance.now(),
  acquireLock = lockMac,
} = {}) {
  const name = INSTALLERS[platform];
  if (!name) {
    log('The Grove Companion is for Windows and macOS.');
    return 1;
  }
  let workspace, mac;
  try {
    if (platform === 'darwin') {
      const folder = macFolder(home, applications, writable);
      const fd = acquireLock(folder);
      const lockedRun = (file, args) => run(file, args, { stdio: ['ignore', 'pipe', 'pipe', fd] });
      mac = { folder, fd, run: lockedRun };
      recoverMac(path.join(folder, APP), path.join(folder, TRANSACTION), lockedRun, log);
    }
    workspace = { dir: fs.mkdtempSync(path.join(tmp, 'grove-companion-')), mounted: false };
    const { dir } = workspace;
    log('Finding the latest Grove Companion…');
    const tag = await latestRelease(fetchImpl);
    log(`Downloading ${name} from ${tag}…`);
    const [installer, sums] = await Promise.all([download(fetchImpl, tag, name), download(fetchImpl, tag, 'SHA256SUMS')]);
    if (crypto.createHash('sha256').update(installer).digest('hex') !== listedHash(sums.toString('utf8'), name)) {
      throw refuse(`${name} does not match the release’s SHA256SUMS, so it was not run.`);
    }
    const file = path.join(dir, name);
    fs.writeFileSync(file, installer);
    log('Checking its signature…');
    if (platform === 'win32') installWindows(file, { env, run, log });
    else installMac(file, { workspace, ...mac, log, wait, now });
    log(`Installed the Grove Companion ${tag}.`);
    return 0;
  } catch (err) {
    log(err.refused ? err.message : `Could not install the Grove Companion: ${err.message}`);
    return 1;
  } finally {
    if (workspace && !workspace.mounted) cleanup(workspace.dir, log);
    if (mac) fs.closeSync(mac.fd);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === COMPANION_RUNNER) {
  installCompanion().then((code) => { process.exitCode = code; });
}
