// Inventory is separate from launchable shells: old tmux and off-PATH or
// incomplete herdr installations still need management controls.
import path from 'node:path';
import { buildSpawnSpec, resolveCommand, resolveAllCommands, runSpec, pathKey } from './command-resolver.mjs';
import { classifyInstall, defaultFsx, formatCommand, homeRelative, installationKey, uninstallPlan } from './install-channels.mjs';
import { parseVersion, parseTmuxVersion, compareVersions, compareTmuxVersions } from './versions.mjs';
import { tmuxSupported } from './shells.mjs';
import { herdrLayout, ownsPathEntry, pathIdentity } from './multiplexer-paths.mjs';
import { RUNNER, encodePlan } from './uninstall.mjs';

const TTL = 60_000;
const LATEST_TTL = 3_600_000;
const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const command = (recipe) => recipe ? formatCommand(recipe.file, recipe.args) : null;
const posixQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";

export function distroCandidate(manager, output) {
  const value = manager === 'apt'
    ? output.match(/^\s*Candidate:\s*(\S+)/m)?.[1]
    : manager === 'pacman' ? output.match(/^Version\s*:\s*(\S+)/m)?.[1] : output.trim().split(/\s+/)[0];
  return parseTmuxVersion(value);
}

export function nativeHerdrEnv(env, platform) {
  const layout = herdrLayout(env, platform);
  return platform === 'win32'
    ? { HERDR_HOME: layout.home, HERDR_INSTALL_DIR: layout.bin }
    : { HERDR_INSTALL_DIR: layout.bin };
}

export class MultiplexerRegistry {
  constructor(registry, { run = runSpec, resolve = resolveCommand, resolveAll = resolveAllCommands, fsx = defaultFsx, uid = () => process.getuid?.() } = {}) {
    Object.assign(this, { registry, run, resolve, resolveAll, fsx, uid });
    this.inventory = new Map();
    this.latest = new Map();
  }

  key(provider, id) { return `${provider.id}:${id}`; }
  definitions(provider) { return provider.command === '@shell' ? provider.multiplexers || [] : []; }
  env(provider) { return { ...this.registry.env, ...provider.env }; }
  get(provider, id) {
    const found = this.definitions(provider).find((m) => m.id === id);
    if (!found) throw error('unknown_multiplexer', `Unknown multiplexer "${id}"`, 404);
    return found;
  }

  describe(provider) {
    return this.definitions(provider).map((definition) => {
      const entry = this.inventory.get(this.key(provider, definition.id));
      return entry?.public || {
        id: definition.id, tool: definition.tool, docs: definition.docs, checked: false,
        available: false, installable: false, installs: [], guidance: 'Checking installation…',
      };
    });
  }

  async execute(file, args, env) {
    return this.run(buildSpawnSpec(file, args, env, this.registry.platform), { env, timeoutMs: 10_000 });
  }

  async systemInstall(file, definition, env) {
    if (definition.id !== 'tmux' || this.registry.platform !== 'linux') return null;
    const candidates = [
      ['apt', 'dpkg', ['-S', file], /^tmux(?::[a-z0-9_-]+)?:\s/m, 'apt-get'],
      ['dnf', 'rpm', ['-qf', '--queryformat', '%{NAME}', file], /^tmux$/, 'dnf'],
      ['pacman', 'pacman', ['-Qqo', file], /^tmux\s*$/, 'pacman'],
    ];
    for (const [manager, query, args, match, binary] of candidates) {
      const probe = this.resolve(query, env, 'linux');
      if (!probe) continue;
      try {
        if (!match.test((await this.execute(probe, args, { ...env, LC_ALL: 'C' })).stdout.trim())) continue;
        const executable = this.resolve(binary, env, 'linux');
        const removal = executable && this.elevated(executable, manager === 'pacman' ? ['-R', 'tmux'] : ['remove', 'tmux'], env);
        return {
          channel: 'system', resolvedPath: file, realPath: this.fsx.realpath(file), key: `system:${manager}:tmux`,
          update: null, uninstall: removal ? { run: removal, remove: [], links: [] } : null,
          guidance: `Managed by ${manager}. Update tmux with your distribution's package manager.`,
        };
      } catch { /* another manager, or no verifiable owner */ }
    }
    return null;
  }

  elevated(file, args, env) {
    if (this.uid() === 0) return { file, args };
    const sudo = this.resolve('sudo', env, this.registry.platform);
    return sudo ? { file: sudo, args: [file, ...args] } : null;
  }

  nativeOwns(file, env) {
    const platform = this.registry.platform;
    const layout = herdrLayout(env, platform);
    const real = pathIdentity(this.fsx.realpath(file), platform);
    if (platform !== 'win32') return real === pathIdentity(layout.launcher, platform) && !this.fsx.isLink(file);
    const p = path.win32;
    return p.basename(real) === 'herdr.exe'
      && pathIdentity(p.dirname(p.dirname(real)), platform) === pathIdentity(layout.releases, platform)
      && pathIdentity(this.fsx.realpath(layout.standalone), platform) === pathIdentity(layout.standalone, platform);
  }

  nativeCopy(file, env, partial = false) {
    const platform = this.registry.platform;
    const layout = herdrLayout(env, platform);
    return {
      channel: 'native', resolvedPath: file, realPath: this.fsx.realpath(file), key: `native:${pathIdentity(layout.launcher, platform)}`,
      partial, update: partial ? null : { file, args: ['update'] },
      uninstall: { run: null, remove: layout.remove, links: layout.links, launcher: partial ? null : file, pathEntries: layout.pathEntries, strict: true },
      guidance: partial ? 'An incomplete herdr installation remains. Install again to repair it before checking server status and removing it.' : null,
    };
  }

  managedPathsSafe(env) {
    const platform = this.registry.platform;
    const p = platform === 'win32' ? path.win32 : path.posix;
    const layout = herdrLayout(env, platform);
    const roots = platform === 'win32' ? [layout.standalone, p.dirname(layout.bin)] : [layout.bin];
    for (const root of roots) {
      for (let parent = root; ; parent = p.dirname(parent)) {
        if (this.fsx.isLink(parent) || pathIdentity(this.fsx.realpath(parent), platform) !== pathIdentity(parent, platform)) return false;
        if (p.dirname(parent) === parent) break;
      }
    }
    if (platform === 'win32' && this.fsx.isLink(layout.bin)) {
      const target = this.fsx.realpath(layout.bin);
      if (pathIdentity(p.dirname(target), platform) !== pathIdentity(layout.releases, platform)) return false;
    }
    return true;
  }

  async inspect(definition, env) {
    const platform = this.registry.platform;
    const onPath = this.resolveAll(definition.id, env, platform);
    const files = [...onPath];
    const layout = herdrLayout(env, platform);
    if (definition.id === 'herdr') {
      const known = [layout.launcher, ...(platform === 'win32' ? [path.win32.join(layout.bin, 'herdr.exe')] : [])];
      for (const file of known) if (this.fsx.isFile(file) && !files.includes(file)) files.push(file);
    }
    const copies = new Map();
    for (const file of files) {
      // Classify Homebrew first, including symlinks in a user's bin directory.
      let copy = classifyInstall({ resolvedPath: file, provider: { ...definition, channels: { brew: definition.channels.brew } }, env, platform, fsx: this.fsx });
      if (copy.channel === 'unknown') {
        if (definition.id === 'herdr' && this.nativeOwns(file, env)) copy = this.nativeCopy(file, env);
        else copy = await this.systemInstall(file, definition, env) || copy;
      }
      copy.key ??= installationKey(copy, definition, platform, this.fsx);
      copy.uninstall ??= uninstallPlan(copy, definition, env, platform, this.fsx);
      copy.onPath = onPath.includes(file);
      copy.active = file === onPath[0];
      if (copies.has(copy.key)) continue;
      try {
        const { stdout } = await this.execute(file, definition.versionArgs, env);
        copy.version = definition.id === 'tmux' ? parseTmuxVersion(stdout) : parseVersion(stdout);
        copy.supported = definition.id !== 'tmux' || tmuxSupported(stdout.trim());
        copy.versionStatus = copy.version ? 'ok' : 'unavailable';
        copy.versionError = null;
      } catch (err) {
        Object.assign(copy, { version: null, supported: false, versionStatus: 'failed', versionError: String(err.message).slice(0, 200) });
      }
      if (copy.channel === 'native' && copy.update) {
        try {
          const out = await this.execute(file, ['update', '--help'], { ...env, ...nativeHerdrEnv(env, platform) });
          if (!/Usage:\s*herdr update/i.test(out.stdout + out.stderr)) copy.update = null;
        } catch { copy.update = null; }
      }
      copies.set(copy.key, copy);
    }
    if (definition.id === 'herdr' && ![...copies.values()].some((c) => c.channel === 'native')) {
      const remnants = layout.remove.some((p) => this.fsx.exists(p))
        || (platform === 'win32' && (env[pathKey(env, platform)] || '').split(';').some((p) => ownsPathEntry(p, layout.pathEntries, env)));
      if (remnants && layout.remove.every((p) => pathIdentity(this.fsx.realpath(p), platform) === pathIdentity(p, platform))) {
        const copy = this.nativeCopy(layout.launcher, env, true);
        copies.set(copy.key, { ...copy, onPath: false, active: false, supported: false, version: null, versionStatus: 'failed' });
      }
    }
    return [...copies.values()];
  }

  async installRecipe(definition, env) {
    const platform = this.registry.platform;
    const resolve = (name) => this.resolve(name, env, platform);
    if (definition.id === 'tmux') {
      if (platform === 'win32') return { guidance: 'Native tmux is not supported on Windows. Install herdr to use a multiplexer here.' };
      let guidance = 'Install tmux 3.2 or later with Homebrew, or use herdr.';
      if (platform === 'linux') {
        for (const [manager, query, args, binary, installArgs] of [
          ['apt', 'apt-cache', ['policy', 'tmux'], 'apt-get', ['install', 'tmux']],
          ['dnf', 'dnf', ['repoquery', '--available', '--latest-limit=1', '--queryformat', '%{version}\\n', 'tmux'], 'dnf', ['install', 'tmux']],
          ['pacman', 'pacman', ['-Si', 'tmux'], 'pacman', ['-S', 'tmux']],
        ]) {
          if (!resolve(query) || !resolve(binary)) continue;
          let candidate = null;
          try { candidate = distroCandidate(manager, (await this.execute(resolve(query), args, { ...env, LC_ALL: 'C' })).stdout); } catch {}
          if (candidate && compareTmuxVersions(candidate, '3.2') >= 0) {
            const recipe = this.elevated(resolve(binary), installArgs, env);
            if (recipe) return { recipe };
          }
          guidance = candidate
            ? `Your distribution offers tmux ${candidate}; Agent Guild needs 3.2 or later and sudo (unless root). Install with Homebrew, or use herdr.`
            : 'Could not verify a usable tmux package. Check your package metadata, install tmux 3.2 or later with Homebrew, or use herdr.';
          break;
        }
      }
      return resolve('brew') ? { recipe: { file: resolve('brew'), args: ['install', 'tmux'] } } : { guidance };
    }
    const extraEnv = nativeHerdrEnv(env, platform);
    if (!this.managedPathsSafe(env)) return { guidance: 'The default herdr installation directory is redirected by a link. Manage this installation with its original installer.' };
    if (platform === 'win32') {
      const powershell = resolve('powershell.exe');
      if (!powershell || !resolve('curl.exe')) return { guidance: 'Install herdr with the Windows installer at https://herdr.dev/docs/install/; PowerShell and curl.exe are required.' };
      return {
        recipe: {
          file: powershell, args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "$ErrorActionPreference = 'Stop'; & ([scriptblock]::Create((Invoke-RestMethod 'https://herdr.dev/install.ps1'))) -Channel stable -ManifestUrl 'https://herdr.dev/latest.json' -ExpectedBuildId ''"],
        },
        extraEnv: { ...extraEnv, HERDR_CHANNEL: 'stable', HERDR_MANIFEST_URL: '', HERDR_EXPECTED_BUILD_ID: '' },
      };
    }
    if (!['sh', 'curl', 'awk'].every(resolve)) return { guidance: 'Install herdr with https://herdr.dev/install.sh; sh, curl and awk are required.' };
    // Download first: a failed curl in a pipe must not look like a successful install.
    return {
      recipe: { file: resolve('sh'), args: ['-c', `script=$(${posixQuote(resolve('curl'))} -fsSL https://herdr.dev/install.sh) || exit $?; ${posixQuote(resolve('sh'))} -c "$script"`] },
      extraEnv,
    };
  }

  async latestFor(definition, copy, env, force) {
    if (!this.registry.checkUpdates) return null;
    let url;
    if (copy.channel === 'brew') url = `https://formulae.brew.sh/api/formula/${definition.id}.json`;
    else if (copy.channel === 'native' && !copy.partial) {
      // Preview identity is not ordinary semver. Do not compare it to stable.
      try {
        const { stdout } = await this.execute(copy.resolvedPath, ['channel', 'show'], { ...env, ...nativeHerdrEnv(env, this.registry.platform) });
        if (stdout.trim() !== 'stable') return null;
      } catch { return null; }
      url = 'https://herdr.dev/latest.json';
    }
    if (!url || !this.registry.checkUpdates) return null;
    const cached = this.latest.get(url);
    if (!force && cached && Date.now() - cached.at < LATEST_TTL) return cached.version;
    let version = null;
    try {
      const response = await (this.registry.fetchImpl || fetch)(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        const body = await response.json();
        const raw = copy.channel === 'brew' ? body.versions?.stable : body.version;
        version = definition.id === 'tmux' ? parseTmuxVersion(raw) : parseVersion(raw);
      }
    } catch {}
    this.latest.set(url, { version, at: Date.now() });
    return version;
  }

  async refresh(provider, { force = false } = {}) {
    let changed = false;
    await Promise.all(this.definitions(provider).map(async (definition) => {
      const key = this.key(provider, definition.id);
      const previous = this.inventory.get(key);
      if (!force && previous && Date.now() - previous.at < TTL) return;
      const env = this.env(provider);
      const unsupported = definition.id === 'tmux' && this.registry.platform === 'win32';
      const copies = unsupported ? [] : await this.inspect(definition, env);
      const install = await this.installRecipe(definition, env);
      const active = copies.find((c) => c.active);
      const compare = definition.id === 'tmux' ? compareTmuxVersions : compareVersions;
      const installs = await Promise.all(copies.map(async (copy) => {
        const latestVersion = await this.latestFor(definition, copy, env, force);
        const guidance = copy.guidance || (!copy.update ? 'Update this copy the way you installed it.'
          : !latestVersion ? `Latest version is unknown. You can run ${command(copy.update)} to check for an update using this installation's channel.` : null);
        return {
          path: copy.resolvedPath, key: copy.key, displayPath: homeRelative(copy.resolvedPath, env, this.registry.platform),
          channel: copy.channel, version: copy.version, versionStatus: copy.versionStatus,
          active: copy.active, onPath: copy.onPath, partial: Boolean(copy.partial), supported: copy.supported,
          latestVersion, updateAvailable: Boolean(copy.version && latestVersion && compare(latestVersion, copy.version) > 0),
          updateCommand: command(copy.update), updateGuidance: guidance,
          uninstall: copy.uninstall && { command: command(copy.uninstall.run), remove: [...copy.uninstall.remove, ...copy.uninstall.links].map((p) => homeRelative(p, env, this.registry.platform)), pathEntries: Boolean(copy.uninstall.pathEntries) },
          uninstallGuidance: copy.uninstall ? null : 'Remove this copy the way you installed it.',
        };
      }));
      const offPath = copies.some((c) => !c.onPath && !c.partial);
      const old = active && definition.id === 'tmux' && !active.supported;
      const publicInfo = {
        id: definition.id, tool: definition.tool, docs: definition.docs, checked: true,
        available: Boolean(active?.supported), installable: Boolean(install.recipe && !copies.some((c) => !c.partial)),
        installCommand: command(install.recipe), installs,
        guidance: unsupported ? install.guidance : old ? `tmux ${active.version || 'at this path'} cannot be started here; 3.2 or later is required. ${install.guidance || 'Remove the old copy before installing a supported one.'}`
          : offPath ? `A copy exists off PATH. Add its directory to your shell's PATH, then Refresh to make it available.`
            : copies.some((c) => c.partial) ? copies.find((c) => c.partial).guidance : copies.length ? null : install.guidance || null,
        lastInstall: previous?.public.lastInstall ?? null,
      };
      changed ||= JSON.stringify(previous?.public) !== JSON.stringify(publicInfo);
      this.inventory.set(key, { at: Date.now(), copies, install, public: publicInfo });
    }));
    return changed;
  }

  copyFor(provider, id, file) {
    return this.inventory.get(this.key(provider, id))?.copies.find((c) => pathIdentity(c.resolvedPath, this.registry.platform) === pathIdentity(file, this.registry.platform));
  }

  identityFor(provider, id, file) {
    const cached = this.copyFor(provider, id, file);
    if (cached) return cached.key;
    const definition = this.definitions(provider).find((m) => m.id === id);
    if (!definition) return null;
    const env = this.env(provider);
    if (id === 'herdr' && this.nativeOwns(file, env)) return this.nativeCopy(file, env).key;
    const copy = classifyInstall({ resolvedPath: file, provider: definition, env, platform: this.registry.platform, fsx: this.fsx });
    return copy.channel === 'unknown' ? null : installationKey(copy, definition, this.registry.platform, this.fsx);
  }

  async prepare(provider, id, kind, copyPath) {
    this.get(provider, id);
    await this.registry.refreshVersions({ force: true, ids: [provider.id] });
    const entry = this.inventory.get(this.key(provider, id));
    const env = this.env(provider);
    if (kind === 'install') {
      if (!entry.public.installable) throw error('not_installable', entry.public.guidance || 'This tool is already installed or has no supported installer.', 400);
      return { spec: buildSpawnSpec(entry.install.recipe.file, entry.install.recipe.args, env, this.registry.platform), extraEnv: entry.install.extraEnv, copy: null };
    }
    if (typeof copyPath !== 'string' || !copyPath) throw error('bad_request', 'path must name the installation to change', 400);
    const copy = this.copyFor(provider, id, copyPath);
    if (!copy) throw error('unknown_copy', 'The selected installation is no longer present. Refresh and try again.', 404);
    const recipe = kind === 'update' ? copy.update : copy.uninstall;
    if (!recipe) throw error(kind === 'update' ? 'not_updatable' : 'not_removable', copy.guidance || 'Manage this copy with its original installer.', 400);
    const spec = kind === 'update'
      ? buildSpawnSpec(recipe.file, recipe.args, env, this.registry.platform)
      : buildSpawnSpec(process.execPath, [RUNNER, encodePlan(recipe)], env, this.registry.platform);
    return { spec, copy, extraEnv: copy.channel === 'native' ? nativeHerdrEnv(env, this.registry.platform) : null };
  }

  async assertHerdrStopped(provider, copy, extraEnv) {
    try {
      if (copy.partial) throw new Error('herdr executable is missing');
      const env = { ...this.env(provider), ...extraEnv };
      const { stdout } = await this.execute(copy.resolvedPath, ['session', 'list', '--json'], env);
      const body = JSON.parse(stdout);
      if (!Array.isArray(body.sessions) || body.sessions.some((s) => typeof s.running !== 'boolean')) throw new Error('invalid session listing');
      if (body.sessions.some((s) => s.running)) {
        throw error('herdr_running', 'Stop herdr before uninstalling: herdr server stop (and herdr session stop <name> for other running sessions).');
      }
    } catch (err) {
      if (err.code === 'herdr_running') throw err;
      throw error('herdr_status_unknown', 'Cannot safely determine whether herdr is running. Repair the installation if necessary, then check herdr session list --json before retrying.');
    }
  }

  async finish(provider, id, kind, copy, exitCode) {
    const key = this.key(provider, id);
    const before = copy?.version;
    await this.registry.refreshVersions({ force: true, ids: [provider.id] });
    const entry = this.inventory.get(key);
    if (!entry) return;
    const after = copy && entry.copies.find((c) => c.key === copy.key);
    const outcome = exitCode !== 0 ? 'failed' : kind === 'uninstall' ? after ? 'remaining' : 'removed'
      : kind === 'install' ? entry.public.available ? 'installed' : 'missing'
        : !after || after.partial ? 'missing' : after.version && after.version === before ? 'unchanged' : 'updated';
    const checked = kind === 'install' ? entry.copies.find((c) => c.active) : after;
    entry.public.lastInstall = { kind, outcome, exitCode, ...(kind !== 'uninstall' && checked?.versionStatus === 'failed' ? { verification: 'failed' } : {}) };
    this.registry.emit('updated');
  }
}
