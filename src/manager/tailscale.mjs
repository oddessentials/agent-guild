import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveCommand } from './command-resolver.mjs';
import { parseAllowedHosts } from './access-policy.mjs';

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
export const remoteError = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

export function findTailscale(env = process.env, platform = process.platform, exists = fs.existsSync) {
  const onPath = resolveCommand(platform === 'win32' ? 'tailscale.exe' : 'tailscale', env, platform);
  const candidates = [onPath];
  if (platform === 'win32') {
    for (const dir of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (dir) candidates.push(path.win32.join(dir, 'Tailscale', 'tailscale.exe'));
    }
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale');
  } else candidates.push('/usr/bin/tailscale', '/usr/local/bin/tailscale');
  return candidates.find((file) => file && (platform !== 'win32' || /\.exe$/i.test(file)) && exists(file)) || null;
}

export function approvalLink(output) {
  for (const match of output.matchAll(/https:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(match[0]);
      if (url.hostname === 'login.tailscale.com' && !url.username && !url.password && !url.port) return url.href;
    } catch {}
  }
  return null;
}

export function runTailscale(file, args, { env = process.env, signal, onApproval, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = execFile(file, args, {
      env: { ...env, TAILSCALE_BE_CLI: '1' }, windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', signal,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout);
      const detail = `${stderr || ''}\n${stdout || ''}`.trim().slice(-2000);
      const url = approvalLink(detail || output);
      if (url) return reject(Object.assign(remoteError('approval_required', 'Approve HTTPS in Tailscale, then continue setup.'), { approvalUrl: url }));
      if (/access denied|permission denied|must be.*(?:root|admin)|sudo tailscale|not permitted|serve config denied/i.test(detail)) {
        return reject(remoteError('permission_required', 'Tailscale needs permission to configure remote access.'));
      }
      if (error.killed || error.code === 'ABORT_ERR') return reject(remoteError('tailscale_timeout', 'Tailscale did not finish. Check its connection and try again.'));
      reject(remoteError('tailscale_error', detail || 'Could not communicate with Tailscale. Open Tailscale and check its connection.'));
    });
    const collect = (chunk) => {
      output = (output + chunk).slice(-8192);
      const url = approvalLink(output);
      if (url) onApproval?.(url);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
  });
}

function parseJson(raw) {
  let value;
  try { value = JSON.parse(raw); } catch {}
  if (value === null) return {};
  if (!object(value)) throw remoteError('tailscale_response', 'Tailscale returned an unreadable status. Update Tailscale and try again.');
  return value;
}

export function validateServeConfig(config) {
  if (!object(config)) throw remoteError('tailscale_response', 'Tailscale returned an unreadable Serve configuration.');
  for (const key of ['TCP', 'Web', 'AllowFunnel', 'Foreground', 'Services']) {
    if (config[key] !== undefined && config[key] !== null && !object(config[key])) {
      throw remoteError('tailscale_response', 'Tailscale returned an unsupported Serve configuration.');
    }
  }
  for (const [port, value] of Object.entries(config.TCP || {})) {
    if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535 || !object(value)) {
      throw remoteError('tailscale_response', 'Tailscale returned an unsupported TCP configuration.');
    }
  }
  for (const value of Object.values(config.Web || {})) {
    if (!object(value) || !object(value.Handlers) || Object.values(value.Handlers).some((handler) => !object(handler))) {
      throw remoteError('tailscale_response', 'Tailscale returned an unsupported web configuration.');
    }
  }
  if (Object.values(config.AllowFunnel || {}).some((value) => typeof value !== 'boolean')) {
    throw remoteError('tailscale_response', 'Tailscale returned an unsupported Funnel configuration.');
  }
  for (const value of Object.values(config.Foreground || {})) {
    if (!object(value) || value.Foreground) throw remoteError('tailscale_response', 'Tailscale returned an unsupported foreground configuration.');
    validateServeConfig(value);
  }
  return config;
}

const ordered = (value) => Array.isArray(value) ? value.map(ordered)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;
export const sameConfig = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
export const routeAuthority = (route) => `${route.host}:${route.port}`;
export const routeUrl = (route) => `https://${route.host}${route.port === 443 ? '' : `:${route.port}`}`;

function foregroundPort(config, port) {
  return Object.values(config.Foreground || {}).some((entry) => entry.TCP?.[port] || Object.keys(entry.Web || {}).some((key) => key.endsWith(`:${port}`)));
}

export function portOccupied(config, port) {
  return Boolean(config.TCP?.[port] || Object.keys(config.Web || {}).some((key) => key.endsWith(`:${port}`))
    || Object.keys(config.AllowFunnel || {}).some((key) => key.endsWith(`:${port}`)) || foregroundPort(config, port));
}

export function routeMatches(config, route) {
  const authority = routeAuthority(route);
  const web = config.Web?.[authority];
  const handler = web?.Handlers?.['/'];
  if (!sameConfig(config.TCP?.[route.port], { HTTPS: true }) || !object(web) || !object(handler)
    || Object.entries(config.AllowFunnel || {}).some(([key, value]) => value && key.endsWith(`:${route.port}`)) || foregroundPort(config, route.port)
    || Object.keys(web.Handlers).length !== 1 || Object.keys(web).some((key) => key !== 'Handlers')
    || Object.keys(handler).some((key) => key !== 'Proxy')
    || Object.keys(config.Web || {}).some((key) => key !== authority && key.endsWith(`:${route.port}`))) return false;
  try {
    const target = new URL(handler.Proxy);
    return target.origin === new URL(route.target).origin && target.pathname === '/' && !target.search && !target.hash && !target.username && !target.password;
  } catch { return false; }
}

export function chooseRoute(info, target, previous = null) {
  if (previous) {
    if (previous.nodeId !== info.nodeId || previous.host !== info.host) {
      throw remoteError('network_changed', 'This computer’s Tailscale identity or address changed. Disable the saved connection before setting up the new address.');
    }
    if (portOccupied(info.config, previous.port) && !routeMatches(info.config, previous)) {
      throw remoteError('route_changed', 'The saved Tailscale route was changed outside Agent Guild. Review it in Tailscale before continuing.');
    }
    return { ...previous, target };
  }
  for (const key of Object.keys(info.config.TCP || {})) {
    const port = Number(key);
    const route = { nodeId: info.nodeId, host: info.host, port, target };
    if (Number.isInteger(port) && port > 0 && port <= 65535 && routeMatches(info.config, route)) return route;
  }
  const port = [443, ...Array.from({ length: 32 }, (_, i) => 8443 + i)].find((candidate) => !portOccupied(info.config, candidate));
  if (!port) throw remoteError('no_port', 'No available HTTPS port was found. Free a Serve port in Tailscale and try again.');
  return { nodeId: info.nodeId, host: info.host, port, target };
}

export class Tailscale {
  constructor({ env = process.env, platform = process.platform, find = findTailscale, run = runTailscale } = {}) {
    Object.assign(this, { env, platform, find, run });
  }

  async command(args, options = {}) {
    const file = this.find(this.env, this.platform);
    if (!file) throw remoteError('not_installed', 'Install Tailscale on this computer to connect it to your network.');
    return this.run(file, args, { env: this.env, ...options });
  }

  async inspect(options = {}) {
    const version = (await this.command(['version'], options)).trim().split(/\s/)[0];
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!match || Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 52)) {
      throw remoteError('update_required', 'Update Tailscale to version 1.52 or later to set up remote access.');
    }
    const status = parseJson(await this.command(['status', '--json', '--peers=false'], options));
    if (!['Running', 'Starting'].includes(status.BackendState)) {
      throw remoteError('not_connected', 'Open Tailscale and connect this computer to your network, then continue.');
    }
    const host = typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '').toLowerCase() : null;
    const nodeId = status.Self?.ID;
    if (!host || typeof nodeId !== 'string' || !nodeId || !host.endsWith('.ts.net')) {
      throw remoteError('address_unavailable', 'Tailscale has not assigned this computer an HTTPS address yet. Check its connection and MagicDNS settings.');
    }
    try { parseAllowedHosts(host); } catch { throw remoteError('address_unavailable', 'Tailscale returned an invalid HTTPS address.'); }
    const config = validateServeConfig(parseJson(await this.command(['serve', 'status', '--json'], options)));
    return { version, host, nodeId, config, httpsReady: Array.isArray(status.CertDomains) && status.CertDomains.includes(host) };
  }

  async enable(route, previous, options = {}) {
    const before = await this.inspect(options);
    if (before.nodeId !== route.nodeId || before.host !== route.host) throw remoteError('network_changed', 'Tailscale changed networks during setup. Check the connection and try again.');
    if (routeMatches(before.config, route)) return;
    if (portOccupied(before.config, route.port) && !(previous && routeMatches(before.config, previous))) {
      throw remoteError('route_changed', 'The selected HTTPS port is now in use. Check the connection and try again.');
    }
    await this.command(['serve', '--bg', `--https=${route.port}`, '--set-path=/', route.target], { ...options, timeout: 30000 });
    const after = await this.inspect(options);
    if (after.nodeId !== route.nodeId || after.host !== route.host || !routeMatches(after.config, route)) {
      throw remoteError('setup_incomplete', 'Tailscale has not finished setting up the private HTTPS route. Complete any approval, then continue.');
    }
  }

  async remove(route, options = {}) {
    const info = await this.inspect(options);
    if (info.nodeId !== route.nodeId || info.host !== route.host) throw remoteError('network_changed', 'Connect Tailscale to the original network to remove its saved route.');
    if (!portOccupied(info.config, route.port)) return info;
    if (!routeMatches(info.config, route)) throw remoteError('route_changed', 'This Serve route was changed outside Agent Guild. It has been left in place; review it in Tailscale.');
    await this.command(['serve', '--bg', `--https=${route.port}`, '--set-path=/', 'off'], options);
    const after = await this.inspect(options);
    if (after.nodeId !== route.nodeId || after.host !== route.host || portOccupied(after.config, route.port)) {
      throw remoteError('cleanup_incomplete', 'The Serve route is still present. Check Tailscale and retry cleanup.');
    }
    return after;
  }
}
