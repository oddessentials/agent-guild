// What a card that runs a Docker CLI plugin shows and offers: the copy `docker` runs, the copies it shadows, who owns
// each, and Install, Update and Remove for Agent Guild's own copy only (see docker-plugin.mjs).
//
// A check of Docker's plugins is applied only if no newer check started and no operation began or ended since it
// started, so a slow answer never overwrites a newer one. An operation goes Installing (its session runs), Verifying
// (Docker is asked again once it ends) and then Ready, or says what went wrong: a runner that exits 0 is not enough,
// Docker must run the recorded copy.

import fs from 'node:fs';
import path from 'node:path';
import { buildSpawnSpec } from './command-resolver.mjs';
import { compareVersions } from './versions.mjs';
import { homeRelative } from './install-channels.mjs';
import { PluginLedger, extraPluginDirs, latestRelease, ownerOf, pluginTarget, readPlugin, reconcile, sha256File, sweepBackups } from './docker-plugin.mjs';
import { RUNNER, encodePlan } from './docker-plugin-runner.mjs';

const RELEASE_TTL_MS = 60 * 60 * 1000;
const FAILED_RELEASE_TTL_MS = 5 * 60 * 1000;
const OWNER_LABELS = { 'agent-guild': 'Agent Guild', 'docker-desktop': 'Docker Desktop', other: 'installed separately' };

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export class PluginCards {
  /**
   * @param {object} registry  the ProviderRegistry (resolve, env, platform, versions, checkUpdates, emit)
   * @param {object} opts
   * @param {string} opts.dir   where receipts and journals live
   * @param {Function} [opts.fetchImpl]
   * @param {Function} [opts.run]   runs `docker info` (tests pass a fake)
   */
  constructor(registry, { dir, fetchImpl, run, hash = sha256File, releasesUrl } = {}) {
    this.registry = registry;
    this.dir = dir;
    this.fetchImpl = fetchImpl ?? ((...args) => fetch(...args));
    this.run = run;
    this.hash = hash;
    this.releasesUrl = releasesUrl || undefined;
    /** provider id -> { seq, applied, epoch, info, phase, release, releaseAt, releaseError, result } */
    this.state = new Map();
  }

  /** The plugin a provider runs as, when Agent Guild manages it: Docker's own `docker`, and a dockerPlugin name. */
  nameOf(provider) {
    if (!provider?.dockerPlugin) return null;
    return path.basename(provider.command, path.extname(provider.command)).toLowerCase() === 'docker' ? provider.dockerPlugin : null;
  }

  _env(provider) {
    return { ...this.registry.env, ...provider.env };
  }

  _entry(provider) {
    let entry = this.state.get(provider.id);
    if (!entry) {
      entry = { seq: 0, applied: 0, epoch: 0, info: null, phase: null, release: null, releaseAt: 0, releaseError: null, result: null };
      this.state.set(provider.id, entry);
    }
    return entry;
  }

  ledger(provider) {
    return new PluginLedger(this.dir, this.nameOf(provider));
  }

  target(provider) {
    return pluginTarget(this.nameOf(provider), this._env(provider), this.registry.platform);
  }

  /** Ends an interrupted change and deletes backups no longer in use. Never throws. */
  tidy(provider) {
    if (this._entry(provider).phase === 'installing') return null;
    try {
      const ledger = this.ledger(provider);
      const done = reconcile(ledger, { hash: this.hash });
      sweepBackups(ledger, { hash: this.hash });
      return done;
    } catch (err) {
      return { outcome: 'conflict', message: `Agent Guild could not finish an earlier change to Docker Agent: ${err.message}` };
    }
  }

  /** Asks Docker which copy it runs, and GitHub for the latest release when due. Resolves to whether anything changed. */
  async refresh(provider, { force = false } = {}) {
    const entry = this._entry(provider);
    const tidied = this.tidy(provider);
    if (tidied?.outcome === 'conflict') entry.result = { kind: 'repair', outcome: 'conflict', message: tidied.message };
    const docker = this.registry.resolve(provider);
    const seq = ++entry.seq;
    const epoch = entry.epoch;
    const info = docker
      ? await readPlugin({ docker, name: this.nameOf(provider), env: this._env(provider), platform: this.registry.platform, ...(this.run ? { run: this.run } : {}) })
      : { path: null, version: null, shadowed: [], error: null, docker: false };
    let changed = false;
    // A newer check, or an operation that began or ended meanwhile, wins.
    if (seq > entry.applied && epoch === entry.epoch) {
      changed = JSON.stringify(info) !== JSON.stringify(entry.info);
      entry.info = { ...info, docker: Boolean(docker) };
      entry.applied = seq;
    }
    const now = Date.now();
    const ttl = entry.release ? RELEASE_TTL_MS : FAILED_RELEASE_TTL_MS;
    if (this.registry.checkUpdates && (force || now - entry.releaseAt > ttl)) {
      entry.releaseAt = now;
      try {
        const release = await latestRelease({ fetchImpl: this.fetchImpl, platform: this.registry.platform, url: this.releasesUrl });
        changed ||= release.version !== entry.release?.version;
        Object.assign(entry, { release, releaseError: null });
      } catch (err) {
        Object.assign(entry, { releaseError: err.message });
      }
    }
    return changed || Boolean(tidied && tidied.outcome !== 'none');
  }

  /** An Install, Update or Remove session started: what Docker said before no longer stands. */
  began(provider) {
    const entry = this._entry(provider);
    entry.epoch++;
    entry.phase = 'installing';
    entry.result = null;
  }

  /** Its session could not start: nothing changed. */
  abandoned(provider) {
    const entry = this._entry(provider);
    entry.epoch++;
    entry.phase = null;
  }

  /** Whether Agent Guild's own copy is installed: the receipt's copy, still exactly as recorded. */
  owned(provider) {
    const managed = this.ledger(provider).receipt().managed;
    return Boolean(managed && this.hash(managed.path) === managed.sha256);
  }

  /** Its session ended: Verifying until Docker is asked again, then the outcome. */
  async finished(provider, { exitCode, kind }) {
    const entry = this._entry(provider);
    entry.epoch++;
    entry.phase = 'verifying';
    this.registry.emit('updated');
    await this.refresh(provider, { force: true });
    entry.phase = null;
    entry.result = this._verify(provider, { exitCode, kind });
    this.registry.emit('updated');
    return entry.result;
  }

  _verify(provider, { exitCode, kind }) {
    const info = this._entry(provider).info;
    const receipt = this.ledger(provider).receipt();
    const target = this.target(provider);
    const shown = (file) => homeRelative(file, this._env(provider), this.registry.platform);
    if (kind === 'uninstall') {
      if (receipt.conflict) return { kind, outcome: 'conflict', message: receipt.conflict };
      if (!receipt.managed && this.hash(target) === null) return { kind, outcome: 'removed', message: null };
      return { kind, outcome: 'failed', message: `Removing Docker Agent did not finish${exitCode ? ` (exit ${exitCode})` : ''}; ${shown(target)} is unchanged.` };
    }
    if (receipt.conflict) return { kind, outcome: 'conflict', message: receipt.conflict };
    const managed = receipt.managed;
    if (!managed || exitCode !== 0) {
      return { kind, outcome: 'failed', message: `${kind === 'install' ? 'Installing' : 'Updating'} Docker Agent did not finish${exitCode ? ` (exit ${exitCode})` : ''}; nothing was changed. Its session says why.` };
    }
    if (!info?.path || path.resolve(info.path) !== path.resolve(target)) {
      return { kind, outcome: 'shadowed', message: `Docker Agent v${managed.version} is installed at ${shown(target)}, but Docker runs ${info?.path ? shown(info.path) : 'no copy'} first.` };
    }
    if (info.version !== managed.version || ownerOf(info.path, { target, receipt, platform: this.registry.platform, env: this._env(provider), hash: this.hash }) !== 'agent-guild') {
      return { kind, outcome: 'failed', message: `Docker runs ${shown(info.path)}, but it is not the v${managed.version} Agent Guild installed.` };
    }
    return { kind, outcome: 'ready', message: null };
  }

  /** Whether Install may run, and what it would change: { ok, reason, note }. */
  installPlan(provider) {
    const entry = this._entry(provider);
    const info = entry.info;
    const env = this._env(provider);
    const platform = this.registry.platform;
    const shown = (file) => homeRelative(file, env, platform);
    const target = this.target(provider);
    if (!this.registry.resolve(provider)) return { ok: false, reason: 'Docker is not installed. Install Docker Desktop, or Docker Engine and its CLI, first.' };
    if (!info) return { ok: false, reason: 'Still checking Docker\'s plugins.' };
    if (info.error && !info.path) return { ok: false, reason: `Could not check Docker's plugins: ${info.error}` };
    const receipt = this.ledger(provider).receipt();
    if (receipt.managed && this.hash(receipt.managed.path) === receipt.managed.sha256) return { ok: false, reason: null };
    let exists = false;
    try { fs.lstatSync(target); exists = true; } catch { /* free */ }
    if (exists) {
      const owner = ownerOf(target, { target, receipt, platform, env, hash: this.hash });
      return {
        ok: false,
        reason: owner === 'docker-desktop'
          ? `Docker Desktop provides Docker Agent at ${shown(target)}; it updates with Docker Desktop.`
          : `${shown(target)} is a copy Agent Guild did not install. Agent Guild leaves it alone; remove it yourself to install Agent Guild's.`,
      };
    }
    if (info.path) {
      const dir = path.dirname(info.path);
      const extras = extraPluginDirs(env, platform);
      if (extras.some((extra) => path.resolve(extra) === path.resolve(dir))) {
        return { ok: false, reason: `Docker runs ${shown(info.path)} first, from cliPluginsExtraDirs, so a copy in ${shown(path.dirname(target))} would never run.` };
      }
      const owner = OWNER_LABELS[ownerOf(info.path, { target, receipt, platform, env, hash: this.hash })];
      return { ok: true, reason: null, note: `Agent Guild's copy will run instead of the ${owner} copy at ${shown(info.path)}.` };
    }
    return { ok: true, reason: null, note: null };
  }

  /** The runner session for an operation: { spec, channel }, or throws a refusal saying why it cannot run. */
  async operation(provider, op, copyPath = null) {
    const name = this.nameOf(provider);
    const target = this.target(provider);
    const plan = { op, name, target, ledgerDir: this.dir };
    if (op === 'install') {
      await this.refresh(provider);
      const install = this.installPlan(provider);
      if (!install.ok) throw refusal(409, 'not_installable', install.reason || `${provider.tool} is already installed by Agent Guild.`);
    } else {
      const receipt = this.ledger(provider).receipt();
      if (!receipt.managed || (copyPath && path.resolve(copyPath) !== path.resolve(target))) {
        throw refusal(400, 'not_removable', `Agent Guild changes only the copy it installed; ${copyPath || target} is not it.`);
      }
    }
    if (op !== 'remove') {
      try {
        plan.release = await latestRelease({ fetchImpl: this.fetchImpl, platform: this.registry.platform, url: this.releasesUrl });
      } catch (err) {
        throw refusal(503, 'release_unresolved', `Could not read the latest ${provider.tool} release: ${err.message}. Nothing was changed.`);
      }
      const managed = this.ledger(provider).receipt().managed;
      if (op === 'update' && managed && compareVersions(plan.release.version, managed.version) <= 0) {
        throw refusal(409, 'up_to_date', `${provider.tool} v${managed.version} is the latest release.`);
      }
    }
    return { spec: buildSpawnSpec(process.execPath, [RUNNER, encodePlan(plan)], this.registry.env, this.registry.platform), channel: 'agent-guild' };
  }

  /** The card's fields for a plugin provider, over the ones `describe` worked out for the docker command. */
  describe(provider, base, { installing = false } = {}) {
    const entry = this._entry(provider);
    const info = entry.info;
    const env = this._env(provider);
    const platform = this.registry.platform;
    const shown = (file) => homeRelative(file, env, platform);
    const target = this.target(provider);
    const receipt = this.ledger(provider).receipt();
    const ownerOfCopy = (file) => ownerOf(file, { target, receipt, platform, env, hash: this.hash });
    const copies = info?.path ? [info.path, ...info.shadowed] : [];
    const installs = copies.map((file, i) => {
      const owner = ownerOfCopy(file);
      return {
        path: file,
        displayPath: shown(file),
        channel: owner,
        version: i === 0 ? info.version : null,
        versionStatus: null,
        active: i === 0,
        onPath: true,
        newer: false,
        uninstall: owner === 'agent-guild' ? { command: null, remove: [shown(file)] } : null,
        uninstallGuidance: owner === 'docker-desktop' ? 'Docker Desktop manages this copy.' : owner === 'other' ? 'Agent Guild did not install this copy; remove it the way it was installed.' : null,
      };
    });
    const active = installs[0] ?? null;
    const managed = active?.channel === 'agent-guild' ? receipt.managed : null;
    const latest = entry.release?.version ?? null;
    const updateAvailable = Boolean(managed && latest && compareVersions(latest, managed.version) > 0);
    const install = this.installPlan(provider);
    const phase = installing ? 'installing' : entry.phase;
    const result = entry.result;
    const message = phase === 'installing' ? null
      : result && result.outcome !== 'ready' && result.outcome !== 'removed' ? result.message
      // Without any copy the reason Install is blocked is the card's install line; beside another copy it is said here.
      : info?.error ?? (install.ok ? install.note : info?.path ? install.reason : null);
    return {
      ...base,
      available: Boolean(info?.path && !info.error),
      installable: install.ok,
      install: install.ok ? '' : install.reason || '',
      installedVersion: info?.version ?? null,
      versionStatus: info?.path ? (info.error ? 'failed' : 'ok') : null,
      versionError: info?.error ?? null,
      latestVersion: latest,
      updateAvailable,
      installChannel: active?.channel ?? null,
      updateCommand: updateAvailable ? `the v${latest} release from GitHub, checked against its SHA-256` : null,
      updateGuidance: active && !managed ? active.uninstallGuidance : null,
      installs,
      warnings: installs.length > 1 ? [`${installs.length} copies of ${provider.tool} are installed. Docker runs the ${OWNER_LABELS[active.channel]} copy at ${active.displayPath}.`] : [],
      plugin: { target: shown(target), phase: phase ?? (info?.path ? 'ready' : 'missing'), outcome: result?.outcome ?? null, message: message || null },
    };
  }
}
