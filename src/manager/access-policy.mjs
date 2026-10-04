import { isIP } from 'node:net';

export function parseAllowedHosts(value = '') {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Allowed hosts must be a comma-separated list of hostnames.');
  const entries = value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (entries.length > 64) throw new Error('At most 64 allowed hosts may be configured.');
  for (const entry of entries) {
    const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([1-9]\d{0,4}))?$/.exec(entry);
    const name = match?.[1];
    const validName = name?.startsWith('[') ? isIP(name.slice(1, -1)) === 6
      : name && name.length <= 253 && name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
    if (!validName || (match[2] && Number(match[2]) > 65535)) {
      throw new Error(`Invalid allowed host ${JSON.stringify(entry)}. Use a hostname with an optional port, such as guild.example.ts.net or guild.example.ts.net:8443; URLs and wildcards are not allowed.`);
    }
  }
  return [...new Set(entries)];
}

export function parseAllowedOrigins(value = '') {
  if (typeof value !== 'string' || value.length > 16384) throw new Error('Allowed origins must be a comma-separated list of HTTP or HTTPS origins.');
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > 64) throw new Error('At most 64 allowed origins may be configured.');
  return [...new Set(entries.map((entry) => {
    let url;
    try { url = new URL(entry); } catch {}
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== entry || url.username || url.password) {
      throw new Error(`Invalid allowed origin ${JSON.stringify(entry)}. Use an HTTP or HTTPS origin without a path or trailing slash.`);
    }
    parseAllowedHosts(url.host);
    return url.origin;
  }))];
}

export function normalizeAccess({ hosts = [], origins = [] } = {}) {
  if (!Array.isArray(hosts) || !Array.isArray(origins) || [...hosts, ...origins].some((value) => typeof value !== 'string')) {
    throw new Error('Allowed hosts and origins must be lists of strings.');
  }
  return { hosts: parseAllowedHosts(hosts.join(',')), origins: parseAllowedOrigins(origins.join(',')) };
}
