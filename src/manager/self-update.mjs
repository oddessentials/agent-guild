// The manager's own version against the npm registry, and the npm session
// that upgrades it. The running process keeps its code after an upgrade:
// the new version is used once the manager is restarted.

import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { compareVersions, fetchManifest } from './versions.mjs';
import { formatCommand } from './install-channels.mjs';

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
   * @param {import('./providers.mjs').ProviderRegistry} opts.registry  for the registry URL, npm, and fetch
   */
  constructor({ pkg, version, packageFile = null, registry }) {
    super();
    this.pkg = pkg;
    this.version = version;
    this.packageFile = packageFile;
    this.registry = registry;
    this.latest = null;
    this.error = null;
    this.checkedAt = 0;
    this.lastInstall = null;
    this._refreshing = null;
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
    const ttl = this.latest ? CHECK_TTL_MS : FAILED_CHECK_TTL_MS;
    if (!force && now - this.checkedAt < ttl) return;
    this.checkedAt = now;
    const registryUrl = await this.registry.npmRegistryUrl();
    const { manifest, error } = await fetchManifest(this.pkg, 'latest', { registryUrl, fetchImpl: this.registry.fetchImpl });
    const latest = manifest?.version ?? null;
    const changed = latest !== this.latest || error !== this.error;
    this.latest = latest;
    this.error = error;
    if (changed) this.emit('updated');
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

  /** A version installed on disk that the running manager does not use yet, or null. */
  pendingVersion() {
    const onDisk = this.installedVersion();
    return onDisk && onDisk !== this.version && compareVersions(onDisk, this.version) > 0 ? onDisk : null;
  }

  /** True when the latest release is newer than both the running manager and the files on disk. */
  available() {
    if (!this.latest || isDevelopmentBuild(this.version)) return false;
    const onDisk = this.installedVersion() || this.version;
    return compareVersions(this.latest, this.version) > 0 && compareVersions(this.latest, onDisk) > 0;
  }

  args() {
    return this.registry.npmArgs({ args: ['install', '-g'], package: this.pkg }, this.latest);
  }

  /** The npm command that performs the upgrade, or null without npm on PATH or a known release. */
  command() {
    const npm = this.registry.resolveNpm();
    return npm && this.latest ? formatCommand(npm, this.args()) : null;
  }

  /** Public description, sent in `/info`, `hello` and `manager.upgrade`. */
  describe() {
    const available = this.available();
    const command = available ? this.command() : null;
    return {
      version: this.version,
      latestVersion: this.latest,
      available,
      command,
      guidance: available && !command ? `npm was not found on PATH. Install Node.js from https://nodejs.org, then run: npm install -g ${this.pkg}@${this.latest}` : null,
      pendingVersion: this.pendingVersion(),
      lastInstall: this.lastInstall,
    };
  }

  /** Spawn spec for the upgrade session, or throws with a user-facing message. */
  async spec() {
    await this.refresh();
    if (!this.available()) {
      throw refusal(400, 'not_updatable', this.latest
        ? `Agent Guild ${this.latest} is the latest release${this.pendingVersion() ? ' and is installed; restart the manager to use it' : ''}.`
        : `Could not read the latest Agent Guild release${this.error ? `: ${this.error}` : ''}. Nothing was changed.`);
    }
    const npm = this.registry.resolveNpm();
    if (!npm) {
      throw refusal(409, 'npm_unavailable', 'npm was not found on PATH. Install Node.js from https://nodejs.org and restart the session manager.');
    }
    return { file: npm, args: this.args(), version: this.latest };
  }

  /** Record how the upgrade session ended. The files on disk say whether the running copy was replaced. */
  finishInstall({ exitCode = null, version = this.latest } = {}) {
    const installed = this.installedVersion();
    let outcome;
    if (exitCode !== 0) outcome = 'failed';
    else if (installed && version && compareVersions(installed, version) >= 0) outcome = 'installed';
    else outcome = 'unchanged';
    this.lastInstall = { outcome, exitCode, version, installedVersion: installed, at: Date.now() };
    this.emit('updated');
  }
}
