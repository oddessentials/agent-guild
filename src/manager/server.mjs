// Local HTTP + WebSocket API. The web page is only one client of this API;
// see docs/api.md for the contract other front ends (e.g. Unreal Engine) use.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import { timingSafeEqualString } from './session-manager.mjs';

const require = createRequire(import.meta.url);
const API = '/api/v1';
const MAX_BODY = 64 * 1024;
const MAX_WS_PAYLOAD = 1024 * 1024;
const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function vendorFiles() {
  const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
  return {
    '/vendor/xterm/xterm.js': path.join(pkgDir('@xterm/xterm'), 'lib/xterm.js'),
    '/vendor/xterm/xterm.css': path.join(pkgDir('@xterm/xterm'), 'css/xterm.css'),
    '/vendor/xterm/addon-fit.js': path.join(pkgDir('@xterm/addon-fit'), 'lib/addon-fit.js'),
    '/vendor/xterm/addon-web-links.js': path.join(pkgDir('@xterm/addon-web-links'), 'lib/addon-web-links.js'),
  };
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:*; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; // drain the rest so the 413 response can be read
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        reject(new HttpError(413, 'request body too large', 'too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, 'request body must be a JSON object', 'bad_json'));
        } else resolve(parsed);
      } catch {
        reject(new HttpError(400, 'request body is not valid JSON', 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

export function createManagerServer({
  manager,
  registry,
  token,
  host = '127.0.0.1',
  port = 0,
  webDir,
  version = '0.0.0',
  extraOrigins = [],
  onShutdownRequest = () => {},
}) {
  const startedAt = new Date().toISOString();
  const vendor = vendorFiles();
  let boundPort = port;

  const allowedHosts = () => new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
  const allowedOrigins = () =>
    new Set([`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`, `http://[::1]:${boundPort}`, ...extraOrigins]);

  /** Blocks DNS-rebinding (Host) and cross-site browser requests (Origin). */
  function checkRequestSource(req) {
    const hostHeader = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts().has(hostHeader)) throw new HttpError(403, 'forbidden host', 'forbidden_host');
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== 'null' && !allowedOrigins().has(origin)) {
      throw new HttpError(403, 'forbidden origin', 'forbidden_origin');
    }
    if (origin === 'null') throw new HttpError(403, 'forbidden origin', 'forbidden_origin');
  }

  function requestToken(req, url, { allowQuery = false } = {}) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    if (allowQuery) return url.searchParams.get('token');
    return null;
  }

  function requireAuth(req, url, opts) {
    if (!timingSafeEqualString(requestToken(req, url, opts), token)) {
      throw new HttpError(401, 'missing or invalid API token', 'unauthorized');
    }
  }

  function serveFile(res, file, { cache = false } = {}) {
    fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } });
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': cache ? 'public, max-age=3600' : 'no-cache',
        'Content-Length': data.length,
      });
      res.end(data);
    });
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method not allowed', 'method_not_allowed');
    }
    if (vendor[pathname]) return serveFile(res, vendor[pathname], { cache: true });
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    } catch {
      throw new HttpError(400, 'malformed path', 'bad_path');
    }
    if (rel.includes('\0')) throw new HttpError(404, 'not found', 'not_found');
    const file = path.resolve(webDir, rel);
    if (file !== webDir && !file.startsWith(webDir + path.sep)) {
      throw new HttpError(404, 'not found', 'not_found');
    }
    return serveFile(res, file);
  }

  async function handleApi(req, res, url) {
    const route = url.pathname.slice(API.length) || '/';
    const method = req.method;

    if (route === '/health' && method === 'GET') {
      return sendJson(res, 200, { ok: true, name: 'agent-guild', version, pid: process.pid });
    }

    // Agent reports may authenticate with the per-session report token that
    // the manager injects into each tool's environment.
    const agentMatch = route.match(/^\/sessions\/([a-f0-9]+)\/agents$/);
    if (agentMatch && method === 'POST') {
      const body = await readJsonBody(req);
      const trusted = timingSafeEqualString(requestToken(req, url), token);
      const agent = manager.reportAgent(agentMatch[1], body, {
        trusted,
        reportToken: req.headers['x-agent-guild-report-token'],
      });
      return sendJson(res, 200, { agent });
    }

    requireAuth(req, url);

    if (route === '/info' && method === 'GET') {
      return sendJson(res, 200, {
        name: 'agent-guild',
        version,
        pid: process.pid,
        platform: process.platform,
        startedAt,
        warnings: registry.warnings,
      });
    }
    if (route === '/providers' && method === 'GET') {
      registry.refreshVersions().catch(() => {});
      return sendJson(res, 200, { providers: registry.list() });
    }
    if (route === '/providers/reload' && method === 'POST') {
      registry.reload();
      registry.refreshVersions({ force: true }).catch(() => {});
      return sendJson(res, 200, { providers: registry.list(), warnings: registry.warnings });
    }
    const installMatch = route.match(/^\/providers\/([a-z0-9][a-z0-9_-]{0,31})\/install$/);
    if (installMatch && method === 'POST') {
      const body = await readJsonBody(req);
      const session = manager.install(installMatch[1], { force: body.force === true });
      return sendJson(res, 201, { session: session.toJSON() });
    }
    if (route === '/sessions' && method === 'GET') {
      return sendJson(res, 200, { sessions: manager.list() });
    }
    if (route === '/sessions' && method === 'POST') {
      const body = await readJsonBody(req);
      const session = manager.create(body);
      return sendJson(res, 201, { session: session.toJSON() });
    }
    if (route === '/shutdown' && method === 'POST') {
      sendJson(res, 202, { ok: true });
      setImmediate(onShutdownRequest);
      return undefined;
    }

    const sessionMatch = route.match(/^\/sessions\/([a-f0-9]+)(\/stop)?$/);
    if (sessionMatch) {
      const [, id, action] = sessionMatch;
      if (!action && method === 'GET') return sendJson(res, 200, { session: manager.get(id).toJSON() });
      if (!action && method === 'PATCH') {
        const body = await readJsonBody(req);
        const session = manager.get(id);
        if (typeof body.name !== 'string' || !body.name.trim()) {
          throw new HttpError(400, 'name must be a non-empty string', 'bad_name');
        }
        session.rename(body.name);
        return sendJson(res, 200, { session: session.toJSON() });
      }
      if (!action && method === 'DELETE') {
        manager.remove(id);
        return sendJson(res, 200, { ok: true });
      }
      if (action === '/stop' && method === 'POST') {
        return sendJson(res, 200, { session: manager.stop(id).toJSON() });
      }
    }
    throw new HttpError(404, `no route for ${method} ${url.pathname}`, 'not_found');
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      checkRequestSource(req);
      if (url.pathname === API || url.pathname.startsWith(API + '/')) await handleApi(req, res, url);
      else serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error('[server]', err);
      if (!res.headersSent) {
        const error = { code: err.code || 'error', message: err.message };
        if (err.running !== undefined) error.running = err.running;
        sendJson(res, status, { error });
      }
    }
  });

  // ---- WebSockets -------------------------------------------------------

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });
  const eventClients = new Set();

  const safeSend = (ws, message) => {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > SLOW_CLIENT_BYTES) {
      // The client can reconnect and will receive a fresh snapshot.
      ws.close(4008, 'client too slow');
      return;
    }
    ws.send(JSON.stringify(message));
  };

  const broadcast = (event) => {
    for (const ws of eventClients) safeSend(ws, event);
  };
  manager.on('event', broadcast);
  registry.on('updated', () => broadcast({ type: 'providers.updated', providers: registry.list() }));

  function handleEvents(ws) {
    eventClients.add(ws);
    safeSend(ws, { type: 'hello', version, sessions: manager.list() });
    ws.on('close', () => eventClients.delete(ws));
    ws.on('message', () => { /* events socket is server -> client only */ });
  }

  function handleTerminal(ws, id) {
    let session;
    try {
      session = manager.get(id);
    } catch (err) {
      safeSend(ws, { type: 'error', code: 'not_found', message: err.message });
      ws.close(4404, 'session not found');
      return;
    }
    const detach = session.attach((message) => {
      safeSend(ws, message);
      if (message.type === 'removed') ws.close(4410, 'session removed');
    });
    ws.on('close', detach);
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
      if (msg.type === 'input' && typeof msg.data === 'string') session.write(msg.data);
      else if (msg.type === 'resize') session.resize(msg.cols, msg.rows);
    });
  }

  server.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
      checkRequestSource(req);
      requireAuth(req, url, { allowQuery: true });
    } catch (err) {
      return reject(err.status || 400, err.status === 401 ? 'Unauthorized' : 'Forbidden');
    }
    const termMatch = url.pathname.match(/^\/api\/v1\/sessions\/([a-f0-9]+)\/terminal$/);
    if (url.pathname !== `${API}/events` && !termMatch) return reject(404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => {});
      if (termMatch) handleTerminal(ws, termMatch[1]);
      else handleEvents(ws);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
  }, 30000);
  heartbeat.unref();

  return {
    server,
    get port() { return boundPort; },
    get url() { return `http://127.0.0.1:${boundPort}`; },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          boundPort = server.address().port;
          resolve(boundPort);
        });
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
