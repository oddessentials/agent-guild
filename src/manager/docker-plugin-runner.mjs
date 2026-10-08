#!/usr/bin/env node
// Installs, updates or removes Agent Guild's own copy of a Docker CLI plugin, in a session of its own so the card shows
// its progress. Every change is journaled before a file is touched (see docker-plugin.mjs): a download is staged
// beside the target, checked against the release's SHA-256 and run as a plugin before it replaces anything, and the
// copy it replaces, or the copy removed, is renamed aside rather than deleted, so a running Docker Agent keeps working.
//
//   node docker-plugin-runner.mjs <plan as base64 JSON>
//   plan: { op: "install"|"update"|"remove", name, target, ledgerDir, release?: { version, url, sha256 } }

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSpawnSpec, runSpec } from './command-resolver.mjs';
import { PluginLedger, reconcile, sha256File, sweepBackups } from './docker-plugin.mjs';

export const RUNNER = fileURLToPath(import.meta.url);

export const encodePlan = (plan) => Buffer.from(JSON.stringify(plan)).toString('base64');
const decodePlan = (text) => JSON.parse(Buffer.from(text, 'base64').toString('utf8'));

/** Files beside the target that the Docker CLI never loads: it considers only names that start with "docker-". */
export function sideFiles(target, id) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  return { staged: path.join(dir, `.${base}.staging-${id}`), backup: path.join(dir, `.${base}.old-${id}`) };
}

/** Runs the staged file as a Docker CLI plugin and checks it is the release it should be. */
export async function validatePlugin(file, version, { env = process.env, platform = process.platform } = {}) {
  const { stdout } = await runSpec(buildSpawnSpec(file, ['docker-cli-plugin-metadata'], env, platform), { env, timeoutMs: 30000 });
  let metadata;
  try { metadata = JSON.parse(stdout); } catch { throw new Error('the download does not answer as a Docker CLI plugin'); }
  const reported = String(metadata?.Version || '').replace(/^v/, '');
  if (!metadata?.SchemaVersion || reported !== version) {
    throw new Error(`the download reports itself as ${reported ? `v${reported}` : 'no version'}, not v${version}`);
  }
}

async function download(url, file, { fetchImpl, log }) {
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) throw new Error(`the download answered ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'wx', 0o755);
  let received = 0;
  let shown = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      fs.writeSync(fd, chunk);
      received += chunk.length;
      const percent = total ? Math.floor((received / total) * 100) : 0;
      if (percent >= shown + 10) {
        shown = percent - (percent % 10);
        log(`  ${shown}%`);
      }
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Carries out `plan`. `step(name)` runs before each change ("journal", "download", "validate", "backup", "swap", "commit");
 * tests stop there to leave the change interrupted. Resolves to { outcome, message } as `reconcile` does.
 */
export async function runOperation(plan, { fetchImpl = fetch, validate = validatePlugin, step = () => {}, log = () => {}, hash = sha256File } = {}) {
  const ledger = new PluginLedger(plan.ledgerDir, plan.name);
  const earlier = reconcile(ledger, { hash });
  if (earlier.outcome === 'conflict') log(earlier.message);
  sweepBackups(ledger, { hash });
  const receipt = ledger.receipt();
  const current = hash(plan.target);
  if (plan.op === 'install') {
    // A receipt whose copy is gone or was replaced owns nothing: the copy is still Agent Guild's only if it matches.
    if (receipt.managed && hash(receipt.managed.path) === receipt.managed.sha256) throw new Error(`Agent Guild already installed Docker Agent at ${receipt.managed.path}`);
    if (current !== null || isLink(plan.target)) throw new Error(`${plan.target} already exists, and Agent Guild did not write it. It was left as it is.`);
  } else if (!receipt.managed || receipt.managed.path !== plan.target || current !== receipt.managed.sha256) {
    throw new Error(`${plan.target} is not the copy Agent Guild installed, or it changed since. It was left as it is.`);
  }
  const id = crypto.randomBytes(8).toString('hex');
  const { staged, backup } = sideFiles(plan.target, id);
  const journal = {
    id, op: plan.op, target: plan.target, staged, backup,
    expected: plan.op === 'remove' ? null : plan.release.sha256,
    previous: plan.op === 'install' ? null : current,
    version: plan.op === 'remove' ? null : plan.release.version,
  };
  await step('journal');
  ledger.writeJournal(journal);

  if (plan.op !== 'remove') {
    // A failure here has touched nothing outside the staged file, which reconciliation deletes.
    const undo = (err) => {
      reconcile(ledger, { hash });
      throw err;
    };
    await step('download');
    try {
      fs.mkdirSync(path.dirname(plan.target), { recursive: true });
      log(`Downloading Docker Agent v${plan.release.version}`);
      const got = await download(plan.release.url, staged, { fetchImpl, log });
      if (got !== plan.release.sha256) throw new Error(`the download's SHA-256 is ${got}, not the ${plan.release.sha256} the release publishes`);
    } catch (err) {
      undo(err);
    }
    await step('validate');
    try {
      log('Checking that it runs as a Docker plugin');
      await validate(staged, plan.release.version);
    } catch (err) {
      undo(err);
    }
  }
  if (plan.op !== 'install') {
    await step('backup');
    fs.renameSync(plan.target, backup);
  }
  if (plan.op !== 'remove') {
    await step('swap');
    try {
      // Install never writes over a file that appeared meanwhile; an update's target was just moved aside.
      if (plan.op === 'install') {
        try {
          fs.linkSync(staged, plan.target);
          fs.rmSync(staged);
        } catch (err) {
          // A folder that cannot hold hard links (FAT, some network shares) gets a rename, while the target is still absent.
          if (err.code === 'EEXIST' || hash(plan.target) !== null || isLink(plan.target)) throw err;
          fs.renameSync(staged, plan.target);
        }
      } else {
        fs.renameSync(staged, plan.target);
      }
    } catch (err) {
      const result = reconcile(ledger, { hash });
      throw new Error(`${err.message}${result.message ? `; ${result.message}` : ''}`);
    }
  }
  await step('commit');
  const result = reconcile(ledger, { hash });
  sweepBackups(ledger, { hash });
  return result;
}

function isLink(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

const DONE = { install: 'Installed', update: 'Updated', remove: 'Removed' };

if (process.argv[1] && path.resolve(process.argv[1]) === RUNNER) {
  const plan = decodePlan(process.argv[2] || '');
  const log = (line) => process.stdout.write(`${line}\r\n`);
  runOperation(plan, { log }).then((result) => {
    if (result.outcome === 'committed') {
      log(`${DONE[plan.op]} Docker Agent${plan.release ? ` v${plan.release.version}` : ''} ${plan.op === 'remove' ? 'from' : 'at'} ${plan.target}.`);
      return;
    }
    log(result.message || `${DONE[plan.op]} nothing: the change did not take effect.`);
    process.exitCode = 1;
  }, (err) => {
    log(`${plan.op === 'install' ? 'Install' : plan.op === 'update' ? 'Update' : 'Removal'} failed: ${err.message}`);
    process.exitCode = 1;
  });
}
