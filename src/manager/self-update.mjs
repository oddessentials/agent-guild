// The manager's own version against the npm registry, and the npm session
// that upgrades it. The running process keeps its code after an upgrade:
// the new version is used once the manager is restarted.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { compareVersions, fetchManifest } from './versions.mjs';
import { formatCommand, npmBesideNode, npmOwner } from './install-channels.mjs';
import { npmSpawnSpec } from './command-resolver.mjs';
import { ptyBuild } from './pty.mjs';

const CHECK_TTL_MS = 60 * 60 * 1000;
const FAILED_CHECK_TTL_MS = 5 * 60 * 1000;

/** Shown as the provider of the upgrade session. */
export const SELF_PROVIDER = Object.freeze({
  id: 'agent-guild',
  vendor: 'Agent Guild',
  tool: 'Agent Guild',
  color: '#5B5BD6',
  monogram: 'AG',
  iconUrl: null,
  modelPattern: null,
  env: {},
});

/** True for a build that is not a published release, such as a git checkout. */
export function isDevelopmentBuild(version) {
  return !version || /^0\.0\.0(?:-|$)/.test(String(version));
}

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export class SelfUpdate extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.pkg            the manager's npm package name
   * @param {string} opts.version        the running version
   * @param {string|null} [opts.packageFile]  the package.json the manager runs from; read again after an install
   * @param {import('./providers.mjs').ProviderRegistry} opts.registry  for the registry URL, npm arguments and fetch
   * @param {() => ({ command: string, built: boolean }|null)} [opts.ptyBuild]  node-pty's build on this computer; a stand-in in tests
   * @param {string} [opts.execPath]  the manager's Node.js, whose npm upgrades a prefix that has none of its own
   */
  constructor({ pkg, version, packageFile = null, registry, ptyBuild: readPtyBuild = ptyBuild, execPath = process.execPath }) {
    super();
    this.pkg = pkg;
    this.execPath = execPath;
    this.version = version;
    this.packageFile = packageFile;
    this.registry = registry;
    this.readPtyBuild = readPtyBuild;
    this.latest = null;
    this.error = null;
    this.checkedAt = 0;
    this.lastInstall = null;
    /** True from the start of an upgrade session until its npm process has exited. */
    this.installing = false;
    /** The on-disk version a failed upgrade left behind, not to be trusted until an upgrade completes. */
    this.suspectVersion = null;
    this._refreshing = null;
    this._owner = null;
    this._verifiedOwner();
  }

  /**
   * The global npm prefix that holds the running copy, as `npmOwner` finds it.
   * While package.json is missing, as an upgrade stopped midway leaves it,
   * the prefix last verified still holds the copy, so a retry can go there.
   */
  _verifiedOwner() {
    const owner = this.packageFile ? npmOwner(this.packageFile, this.pkg, this.registry.platform) : null;
    if (owner) this._owner = owner;
    else if (this._owner && fs.existsSync(this.packageFile)) this._owner = null;
    return owner ?? this._owner;
  }

  /** Ask the registry for the latest release, hourly unless `force`. Emits "updated" on a change. */
  refresh({ force = false } = {}) {
    const run = () => this._refresh(force);
    const pending = this._refreshing ? this._refreshing.then(run, run) : run();
    this._refreshing = pending;
    pending.finally(() => { if (this._refreshing === pending) this._refreshing = null; }).catch(() => {});
    return pending;
  }

  async _refresh(force) {
    if (!this.registry.checkUpdates || isDevelopmentBuild(this.version)) return;
    const now = Date.now();
    const ttl = this.error ? FAILED_CHECK_TTL_MS : CHECK_TTL_MS;
    if (!force && now - this.checkedAt < ttl) return;
    this.checkedAt = now;
    const registryUrl = await this.registry.npmRegistryUrl();
    const { manifest, error } = await fetchManifest(this.pkg, 'latest', { registryUrl, fetchImpl: this.registry.fetchImpl });
    // A failed check keeps the release already known; it is still published.
    const latest = manifest?.version ?? this.latest;
    const changed = latest !== this.latest || error !== this.error;
    this.latest = latest;
    this.error = error;
    if (changed) this.emit('updated');
  }

  /** Forget an upgrade's outcome once a newer release or a different install supersedes it. */
  _pruneLastInstall(installed) {
    const last = this.lastInstall;
    if (last && (last.version !== this.latest || last.installedVersion !== installed)) this.lastInstall = null;
  }

  /** The version of the package files on disk, or null when unreadable (for example mid-install). */
  installedVersion() {
    if (!this.packageFile) return null;
    try {
      const version = JSON.parse(fs.readFileSync(this.packageFile, 'utf8')).version;
      return typeof version === 'string' ? version : null;
    } catch {
      return null;
    }
  }

  /**
   * True while the files on disk are what an upgrade that did not finish
   * left behind: npm may have replaced package.json before it was stopped.
   * Kept apart from `lastInstall`, which a newer release supersedes; the
   * files stay suspect until an upgrade completes or they change again.
   */
  _diskSuspect(installed) {
    return this.suspectVersion !== null && installed === this.suspectVersion;
  }

  /** A version installed on disk that the running manager does not use yet, or null. */
  pendingVersion(installed = this.installedVersion()) {
    if (this._diskSuspect(installed)) return null;
    return installed && installed !== this.version && compareVersions(installed, this.version) > 0 ? installed : null;
  }

  /** True when the latest release is newer than the running manager and not yet, or not reliably, on disk. */
  available(installed = this.installedVersion()) {
    if (!this.latest || compareVersions(this.latest, this.version) <= 0) return false;
    return this._diskSuspect(installed) || compareVersions(this.latest, installed || this.version) > 0;
  }

  /**
   * The npm and arguments that upgrade the copy that runs, in the global
   * prefix it was installed into, or `{ error }` when that cannot be
   * established: an npm that installs elsewhere would leave it unchanged.
   */
  _plan() {
    const { platform } = this.registry;
    const owner = this._verifiedOwner();
    if (!owner) {
      const where = this.packageFile ? ` from ${path.dirname(this.packageFile)}` : '';
      return { error: refusal(409, 'not_npm_install', `Agent Guild runs${where}, which is not a global npm install, so it cannot upgrade itself. Update it the way you installed it.`) };
    }
    const args = this.registry.npmArgs({ args: ['install', '-g', '--prefix', owner.prefix], package: this.pkg }, this.latest);
    const npm = owner.npm || npmBesideNode(this.execPath, platform);
    if (!npm) {
      return { error: refusal(409, 'npm_unavailable', `npm was not found in ${owner.prefix} or beside the manager's Node.js (${this.execPath}). Run: ${formatCommand('npm', args)}`) };
    }
    return { npm, args };
  }

  /** Public description, sent in `/info`, `hello` and `manager.upgrade`. */
  describe() {
    // While npm runs, the files on disk are in flux: package.json may already
    // be new while dependencies are still being written, so nothing is
    // offered or announced until the process has exited.
    if (this.installing) {
      return {
        version: this.version, latestVersion: this.latest, available: false, command: null, guidance: null,
        pendingVersion: null, installing: true, lastInstall: null, ptyBuild: null,
      };
    }
    const installed = this.installedVersion();
    this._pruneLastInstall(installed);
    const available = this.available(installed);
    const plan = available ? this._plan() : null;
    return {
      version: this.version,
      latestVersion: this.latest,
      available,
      command: plan?.npm ? formatCommand(plan.npm, plan.args) : null,
      guidance: plan?.error?.message ?? null,
      pendingVersion: this.pendingVersion(installed),
      installing: false,
      lastInstall: this.lastInstall,
      // Where node-pty has to be compiled here, an upgrade replaces that build.
      ptyBuild: this.readPtyBuild(),
    };
  }

  /** Spawn spec for the upgrade session and the version it installs, or throws with a user-facing message. */
  async spec() {
    if (this.installing) throw refusal(409, 'upgrade_in_progress', 'Agent Guild is already being upgraded');
    if (isDevelopmentBuild(this.version)) {
      throw refusal(400, 'not_updatable', `This is a development build of Agent Guild (${this.version}); it is not upgraded from the registry.`);
    }
    if (!this.registry.checkUpdates) {
      throw refusal(400, 'not_updatable', 'Version checks are off (AGENT_GUILD_NO_UPDATE_CHECK), so Agent Guild cannot upgrade itself.');
    }
    await this.refresh();
    const installed = this.installedVersion();
    this._pruneLastInstall(installed);
    if (!this.available(installed)) {
      throw refusal(400, 'not_updatable', this.latest
        ? `Agent Guild ${this.latest} is the latest release${this.pendingVersion(installed) ? ' and is installed; restart the manager to use it' : ''}.`
        : `Could not read the latest Agent Guild release${this.error ? `: ${this.error}` : ''}. Nothing was changed.`);
    }
    const plan = this._plan();
    if (plan.error) throw plan.error;
    return { spec: npmSpawnSpec(plan.npm, plan.args, this.registry.env, this.registry.platform), version: this.latest };
  }

  /** An upgrade session started; hold the lock until finishInstall. Emits "updated". */
  beginInstall() {
    this.installing = true;
    this.emit('updated');
  }

  /** Record how the upgrade session ended, once its process has exited. The files on disk say whether the running copy was replaced. */
  finishInstall({ exitCode = null, version = this.latest } = {}) {
    this.installing = false;
    const installed = this.installedVersion();
    let outcome;
    if (exitCode !== 0) outcome = 'failed';
    else if (installed && version && compareVersions(installed, version) >= 0) outcome = 'installed';
    else outcome = 'unchanged';
    if (outcome === 'failed') this.suspectVersion = installed;
    else if (outcome === 'installed') this.suspectVersion = null;
    this.lastInstall = { outcome, exitCode, version, installedVersion: installed, at: Date.now() };
    this.emit('updated');
  }
}
