import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { normalizeAccess, parseAllowedHosts, parseAllowedOrigins } from './access-policy.mjs';
import { Tailscale, chooseRoute, remoteError, routeMatches, routeUrl } from './tailscale.mjs';

const emptyAccess = () => ({ hosts: [], origins: [] });

function validateRoute(route) {
  if (!route || typeof route.nodeId !== 'string' || !route.nodeId || route.nodeId.length > 256
    || typeof route.host !== 'string' || !route.host.endsWith('.ts.net') || parseAllowedHosts(route.host)[0] !== route.host
    || !Number.isInteger(route.port) || route.port < 1 || route.port > 65535
    || typeof route.target !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(route.target)
    || Number(new URL(route.target).port) > 65535) throw new Error('Invalid saved Tailscale route.');
  return { nodeId: route.nodeId, host: route.host, port: route.port, target: route.target };
}

function routeAccess(route) {
  const url = new URL(routeUrl(route));
  return { hosts: [url.host], origins: [url.origin] };
}

function validateSaved(value) {
  if (!value || value.version !== 1 || typeof value.revision !== 'string' || value.revision.length > 100
    || !['off', 'custom', 'tailscale'].includes(value.mode)) throw new Error('Unsupported remote-access settings.');
  const route = value.route ? validateRoute(value.route) : null;
  if (value.mode === 'tailscale' && !route) throw new Error('Missing saved Tailscale route.');
  if (value.mode !== 'tailscale' && route) throw new Error('Unexpected saved Tailscale route.');
  const access = value.mode === 'off' ? emptyAccess() : value.mode === 'tailscale' ? routeAccess(route) : normalizeAccess(value.access);
  let pending = null;
  if (value.pending) {
    if (!['enable', 'disable'].includes(value.pending.type)) throw new Error('Invalid pending remote-access operation.');
    pending = { type: value.pending.type, route: validateRoute(value.pending.route), ...(value.pending.previous ? { previous: validateRoute(value.pending.previous) } : {}) };
  }
  return { version: 1, revision: value.revision, mode: value.mode, access, route, pending };
}

export function loadRemoteAccess(file, env = process.env) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') return { config: disabledConfig(), source: 'saved', error: 'Remote-access settings could not be read. Local access remains available.' };
  }
  if (raw !== undefined) {
    try {
      if (raw.length > 65536) throw new Error('Settings are too large.');
      return { config: validateSaved(JSON.parse(raw)), source: 'saved', error: null };
    } catch {
      return { config: disabledConfig(), source: 'saved', error: 'Saved remote-access settings are invalid. Set up remote access again to replace them. Local access remains available.' };
    }
  }
  const access = { hosts: parseAllowedHosts(env.AGENT_GUILD_ALLOWED_HOSTS), origins: parseAllowedOrigins(env.AGENT_GUILD_ALLOWED_ORIGINS) };
  const enabled = access.hosts.length > 0 || access.origins.length > 0;
  return { config: { ...disabledConfig(), mode: enabled ? 'custom' : 'off', access }, source: enabled ? 'environment' : 'default', error: null };
}

function disabledConfig() {
  return { version: 1, revision: randomUUID(), mode: 'off', access: emptyAccess(), route: null, pending: null };
}

export function saveRemoteAccess(file, config) {
  const value = validateSaved(config);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(next, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(next, file);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(next); } catch {}
  }
}

export function checkRemoteUrl(url, { signal, pid = process.pid } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok, checkedAt: new Date().toISOString() }); } };
    const timer = setTimeout(() => { request.destroy(); finish(false); }, 7000);
    const request = https.get(`${url}/api/v1/health`, { signal, headers: { 'Cache-Control': 'no-store' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 16384) { request.destroy(); finish(false); }
      });
      response.on('end', () => {
        try {
          const health = JSON.parse(body);
          finish(response.statusCode === 200 && health.name === 'agent-guild' && health.pid === pid);
        } catch { finish(false); }
      });
      response.on('error', () => finish(false));
    });
    request.on('error', () => finish(false));
  });
}

export class RemoteAccess extends EventEmitter {
  constructor({ file, env = process.env, loaded = loadRemoteAccess(file, env), tailscale = new Tailscale({ env }), save = saveRemoteAccess, probe = checkRemoteUrl } = {}) {
    super();
    Object.assign(this, { file, tailscale, save, probe, config: loaded.config, source: loaded.source });
    this.problem = loaded.error ? { code: 'invalid_settings', message: loaded.error } : null;
    this.busy = null;
    this.info = null;
    this.connection = null;
    this.closed = false;
    this.abort = new AbortController();
    this.apply = () => {};
    this.getTarget = () => null;
    this.task = Promise.resolve();
    this.checkTask = null;
  }

  attach({ apply, getTarget }) {
    this.apply = apply;
    this.getTarget = getTarget;
  }

  snapshot() {
    const config = this.config;
    let candidate = null;
    if (this.info && !this.busy && this.getTarget()) {
      try {
        const route = chooseRoute(this.info, this.getTarget(), config.pending?.type === 'enable' ? config.pending.route : config.route);
        candidate = { url: routeUrl(route), existing: !config.route && !config.pending && routeMatches(this.info.config, route) };
      } catch {}
    }
    return {
      available: true, revision: config.revision, source: this.source, mode: config.mode,
      hosts: [...config.access.hosts], origins: [...config.access.origins],
      url: config.route ? routeUrl(config.route) : null,
      busy: this.busy, pending: config.pending?.type || null, problem: this.problem,
      tailscale: this.info ? { connected: true, version: this.info.version, hostname: this.info.host, httpsReady: this.info.httpsReady } : null,
      command: config.pending ? `tailscale serve --bg --https=${config.pending.route.port} --set-path=/ ${config.pending.type === 'disable' ? 'off' : config.pending.route.target}` : null,
      candidate, connection: this.connection,
    };
  }

  publish() { if (!this.closed) this.emit('updated'); }

  persist(next) {
    if (this.closed) throw remoteError('manager_stopping', 'The manager is stopping.');
    const value = validateSaved({ ...next, version: 1, revision: randomUUID() });
    this.save(this.file, value);
    this.config = value;
    this.source = 'saved';
    this.apply(value.access);
    this.publish();
  }

  async check() {
    if (this.closed) return this.snapshot();
    if (this.checkTask) return this.checkTask;
    if (this.busy) return this.snapshot();
    this.busy = 'checking';
    this.publish();
    this.checkTask = this.inspect().finally(() => {
      this.busy = null;
      this.checkTask = null;
      this.publish();
    }).then(() => this.snapshot());
    return this.checkTask;
  }

  async inspect() {
    this.connection = null;
    try {
      this.info = await this.tailscale.inspect({ signal: this.abort.signal });
      const config = this.config;
      if (config.pending) {
        try { chooseRoute(this.info, config.pending.route.target, config.pending.route); } catch (error) {
          const previous = config.pending.previous || config.route;
          if (!previous || !routeMatches(this.info.config, previous)) throw error;
          chooseRoute(this.info, previous.target, previous);
        }
        this.problem = this.problem?.approvalUrl && config.pending.type === 'enable' ? this.problem : { code: 'operation_pending', message: config.pending.type === 'enable'
          ? 'Setup is unfinished. Continue to check and complete it.'
          : 'Access through the saved address is blocked. The Tailscale route still needs cleanup.' };
      } else if (config.route) {
        chooseRoute(this.info, this.getTarget(), config.route);
        if (!routeMatches(this.info.config, config.route) || config.route.target !== this.getTarget()) {
          throw remoteError('repair_required', 'The Tailscale route needs to be updated for this manager.');
        }
        this.problem = null;
        this.connection = await this.probe(routeUrl(config.route), { signal: this.abort.signal });
      } else if (this.problem?.code !== 'invalid_settings') this.problem = null;
    } catch (error) {
      this.info = null;
      this.problem = { code: error.code || 'tailscale_error', message: error.message, ...(error.approvalUrl ? { approvalUrl: error.approvalUrl } : {}) };
    }
  }

  change(body) {
    if (this.closed) throw remoteError('manager_stopping', 'The manager is stopping.');
    if (this.busy) throw remoteError('remote_busy', 'A remote-access operation is already in progress.');
    if (body.revision !== this.config.revision) throw remoteError('stale_settings', 'Remote access changed in another tab. Review the current settings and try again.');
    if (!['enable', 'disable', 'custom', 'forget'].includes(body.action)) throw remoteError('bad_action', 'Choose a valid remote-access action.', 400);
    let access;
    if (body.action === 'custom') {
      if (this.config.route || this.config.pending) throw remoteError('disable_first', 'Disable the Tailscale connection before changing custom proxy settings.');
      try { access = normalizeAccess({ hosts: body.hosts, origins: body.origins }); } catch (error) { throw remoteError('bad_settings', error.message, 400); }
    }
    if (body.action === 'forget' && (this.config.mode !== 'off' || this.config.pending?.type !== 'disable')) {
      throw remoteError('bad_action', 'Only an inactive route awaiting cleanup can be left in Tailscale.', 400);
    }
    this.busy = body.action === 'enable' ? 'enabling' : body.action === 'disable' ? 'disabling' : 'saving';
    this.problem = null;
    this.connection = null;
    this.publish();
    this.task = Promise.resolve().then(async () => {
      if (body.action === 'enable') await this.enable(body.adopt === true);
      else if (body.action === 'disable') await this.disable();
      else if (body.action === 'custom') this.persist({ ...this.config, mode: access.hosts.length || access.origins.length ? 'custom' : 'off', access, route: null, pending: null });
      else this.persist({ ...this.config, pending: null });
    }).catch((error) => {
      this.problem = { code: error.code || 'save_failed', message: error.message, ...(error.approvalUrl ? { approvalUrl: error.approvalUrl } : {}) };
    }).finally(() => {
      this.busy = null;
      this.publish();
    });
    return this.snapshot();
  }

  async enable(adopt) {
    if (this.config.pending?.type === 'disable') throw remoteError('cleanup_required', 'Finish cleanup of the previous route before enabling remote access.');
    const info = await this.tailscale.inspect({ signal: this.abort.signal });
    this.info = info;
    let previous = this.config.pending?.type === 'enable' ? this.config.pending.route : this.config.route;
    let route;
    try { route = chooseRoute(info, this.getTarget(), previous); } catch (error) {
      const fallback = this.config.pending?.previous || this.config.route;
      if (!fallback || !routeMatches(info.config, fallback)) throw error;
      previous = fallback;
      route = chooseRoute(info, this.getTarget(), previous);
    }
    if (!previous && routeMatches(info.config, route) && !adopt) {
      throw remoteError('adoption_required', 'A matching Tailscale route already exists. Choose “Use existing route” to let Agent Guild manage it.');
    }
    this.persist({ ...this.config, pending: { type: 'enable', route, ...(previous ? { previous } : {}) } });
    let approvalUrl = null;
    await this.tailscale.enable(route, previous, {
      signal: this.abort.signal,
      onApproval: (url) => {
        approvalUrl = url;
        this.problem = { code: 'approval_required', message: 'Approve HTTPS in Tailscale to continue setup.', approvalUrl: url };
        this.publish();
      },
    }).catch((error) => {
      if (approvalUrl && error.code === 'setup_incomplete') error.approvalUrl = approvalUrl;
      throw error;
    });
    this.persist({ ...this.config, mode: 'tailscale', access: routeAccess(route), route, pending: null });
    this.problem = null;
    this.info = await this.tailscale.inspect({ signal: this.abort.signal });
    this.connection = await this.probe(routeUrl(route), { signal: this.abort.signal });
  }

  async disable() {
    const route = this.config.pending?.route || this.config.route;
    const previous = this.config.pending?.previous || this.config.route;
    this.persist({ ...this.config, mode: 'off', access: emptyAccess(), route: null, pending: route ? { type: 'disable', route, ...(previous ? { previous } : {}) } : null });
    if (route) {
      try {
        const info = await this.tailscale.inspect({ signal: this.abort.signal });
        const cleanup = previous && info.nodeId === previous.nodeId && info.host === previous.host && routeMatches(info.config, previous) ? previous : route;
        this.info = await this.tailscale.remove(cleanup, { signal: this.abort.signal });
      } catch (error) {
        error.message = `Access through the saved address is blocked. ${error.message}`;
        throw error;
      }
      this.persist({ ...this.config, pending: null });
    }
    this.problem = null;
  }

  close() {
    this.closed = true;
    this.abort.abort();
  }
}
