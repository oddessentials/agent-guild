import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSpawnSpec } from './command-resolver.mjs';
import { formatCommand } from './install-channels.mjs';

export const RUNNER = fileURLToPath(import.meta.url);

export function encodePlan(plan) {
  return Buffer.from(JSON.stringify(plan)).toString('base64url');
}

function comparable(p, platform) {
  const m = platform === 'win32' ? path.win32 : path.posix;
  const out = m.normalize(p.replace(/^\\\\\?\\/, ''));
  return platform === 'win32' ? out.toLowerCase() : out;
}

function inside(file, dir, platform) {
  const m = platform === 'win32' ? path.win32 : path.posix;
  const f = comparable(file, platform);
  const d = comparable(dir, platform);
  return f === d || f.startsWith(d + m.sep);
}

function within(file, dirs, platform) {
  return dirs.some((dir) => inside(file, dir, platform));
}

function linkTarget(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink() ? path.resolve(path.dirname(file), fs.readlinkSync(file).replace(/^\\\\\?\\/, '')) : null;
  } catch {
    return null;
  }
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function firstLink(file) {
  const steps = [];
  for (let p = file; ; p = path.dirname(p)) {
    steps.unshift(p);
    if (path.dirname(p) === p) break;
  }
  return steps.find((p) => linkTarget(p) !== null) ?? null;
}

function launchChain(launcher) {
  const chain = [];
  let file = launcher;
  for (let hops = 0; hops < 40 && exists(file); hops++) {
    chain.push(file);
    const link = firstLink(file);
    if (!link) break;
    chain.push(link);
    file = path.join(linkTarget(link), path.relative(link, file));
  }
  return chain;
}

function removeFile(file) {
  fs.rmSync(file, { recursive: true, force: true, maxRetries: 3 });
}

export function runPlan(
  { run = null, remove = [], links = [], launcher = null },
  { env = process.env, platform = process.platform, log = console.log, rm = removeFile } = {},
) {
  if (run) {
    log(`> ${formatCommand(run.file, run.args)}`);
    const spec = buildSpawnSpec(run.file, run.args, env, platform);
    const verbatim = typeof spec.args === 'string';
    const result = spawnSync(spec.file, verbatim ? [spec.args] : spec.args, { stdio: 'inherit', env, windowsVerbatimArguments: verbatim });
    if (result.error) {
      log(`Could not run ${run.file}: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) return result.status ?? 1;
  }
  const chain = launcher ? launchChain(launcher) : [];
  const holdsChain = (file) => chain.some((kept) => inside(kept, file, platform));
  const inChain = (file) => chain.some((kept) => comparable(kept, platform) === comparable(file, platform));
  const del = (file) => {
    try {
      rm(file);
    } catch (err) {
      throw Object.assign(err, { file });
    }
  };
  const prune = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (!holdsChain(file)) del(file);
      else if (!inChain(file) && linkTarget(file) === null) prune(file);
    }
  };
  const owned = [];
  const deferred = [];
  try {
    for (const file of [...remove, ...links]) {
      const target = linkTarget(file);
      if (target === null && !exists(file)) continue;
      if (target !== null && !within(target, remove, platform)) {
        log(`Kept ${file}: it links to ${target}, outside this installation.`);
        continue;
      }
      if (target === null && links.includes(file)) {
        log(`Kept ${file}: it is not a link to this installation.`);
        continue;
      }
      owned.push(file);
      if (!holdsChain(file)) {
        del(file);
        log(`Removed ${file}`);
        continue;
      }
      deferred.push(file);
      if (target === null && fs.lstatSync(file).isDirectory()) prune(file);
    }
    for (const file of [...new Set([...chain].reverse())]) {
      if (within(file, owned, platform) && exists(file)) del(file);
    }
    for (const file of deferred.sort((a, b) => b.length - a.length)) {
      if (exists(file)) del(file);
      log(`Removed ${file}`);
    }
  } catch (err) {
    const code = err.code === 'ENOTDIR' && err.syscall === 'scandir' ? 'EPERM' : err.code;
    const reason = { EBUSY: 'it is in use', EPERM: 'it is in use or protected', EACCES: 'permission was denied' }[code] || err.message;
    log(`Could not remove ${err.path || err.file}: ${reason}. Stopped there. Close any program using it, then uninstall again.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === RUNNER) {
  const plan = JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8') || '{}');
  process.exitCode = runPlan(plan);
}
