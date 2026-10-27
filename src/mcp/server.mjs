// `agent-guild mcp`: a Model Context Protocol server on stdin and stdout, so a
// coding agent (Claude Code, Codex CLI, Gemini CLI, Cursor and others) can see
// and steer the sessions of this computer's Agent Guild through its local API.
//
// It never returns the API token or the page link: either one gives full
// control of every session, and anything a tool returns lands in the agent's
// context. Typing into a session is off unless `--allow-input` turns it on.

import readline from 'node:readline';
import WebSocket from 'ws';
import headless from '@xterm/headless';
import { DEFAULT_HOST, VERSION, loadOrCreateToken, readRuntimeFile, resolvePort } from '../manager/config.mjs';
import { cleanResumeId } from '../manager/resume-id.mjs';

const { Terminal } = headless;

/** Newest first; an older client gets its own version back when it is listed. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05'];
const REQUEST_TIMEOUT_MS = 10000;
const START_TIMEOUT_MS = 50000;
const SCREEN_TIMEOUT_MS = 5000;
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HIDDEN = '[token hidden]';
// 64 bits of the known token; leave colors, short hashes and 12-digit session ids readable.
const MIN_TOKEN_FRAGMENT = 16;

const INSTRUCTIONS = `Agent Guild runs coding agents (Claude Code, Codex CLI, Antigravity CLI, Grok Build, Docker Agent) and shells in real terminals on this computer, and opens them on every other screen.
Use guild_status first, list_sessions to see the sessions, read_reply for the answer that ended a session's last turn, and read_screen for what its terminal shows now.
Ask the person before starting or stopping a session. Never ask for, print or store the Agent Guild page link or access token.`;

const sessionId = { type: 'string', description: 'The session id from list_sessions.' };

const TOOLS = [
  {
    name: 'guild_status',
    title: 'Agent Guild status',
    description: 'Whether Agent Guild is running on this computer, its version, and how many sessions it has.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_sessions',
    title: 'List sessions',
    description: 'Every session in Agent Guild: its id, tool, folder, status, whether it is working, its model, its sub-agents, and whether it has a reply to read.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_reply',
    title: 'Read a reply',
    description: "The whole text of the answer that ended a session's last turn, as Markdown. Only tools with reporting on (Claude Code, Codex CLI, Antigravity CLI, Grok Build, Docker Agent) have one.",
    inputSchema: { type: 'object', properties: { session_id: sessionId }, required: ['session_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_screen',
    title: 'Read a terminal',
    description: "The text a session's terminal shows right now, as plain lines. Use it to see a question the tool is waiting on.",
    inputSchema: { type: 'object', properties: { session_id: sessionId }, required: ['session_id'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'start_session',
    title: 'Start a session',
    description: 'Start a new session of a coding tool or shell in Agent Guild. Ask the person first. It opens on every screen connected to Agent Guild.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'The tool: "claude", "codex", "antigravity", "grok", "docker" or "shell", or a provider id from guild_status.' },
        cwd: { type: 'string', description: 'The folder to start in. Defaults to the home folder.' },
        name: { type: 'string', description: "A name for the session's card." },
        account: { type: 'string', description: 'The account id to run under. Defaults to "default".' },
        resume: { type: 'string', description: "The id of one of the tool's own earlier sessions to resume." },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'stop_session',
    title: 'Stop a session',
    description: "End a session's process. Ask the person first. The session stays listed, with its final screen, until it is removed in Agent Guild.",
    inputSchema: { type: 'object', properties: { session_id: sessionId }, required: ['session_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
];

const INPUT_TOOL = {
  name: 'send_input',
  title: 'Type into a session',
  description: "Type text into a session's terminal, as if the person typed it, and press Enter unless submit is false. Read the screen first, and send only what the person asked for.",
  inputSchema: {
    type: 'object',
    properties: {
      session_id: sessionId,
      text: { type: 'string', description: 'The text to type.' },
      submit: { type: 'boolean', description: 'Press Enter after the text. Defaults to true.' },
    },
    required: ['session_id', 'text'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

/** A refusal the agent should read, rather than a fault of the server. */
class ToolError extends Error {}

/** Where the running manager answers, as the launcher finds it. */
export function managerUrl() {
  const runtime = readRuntimeFile();
  return runtime?.url || `http://${DEFAULT_HOST}:${resolvePort()}`;
}

export function createGuildClient({ url = managerUrl, token = loadOrCreateToken, startTimeoutMs = START_TIMEOUT_MS } = {}) {
  const base = () => (typeof url === 'function' ? url() : url);
  const secret = () => (typeof token === 'function' ? token() : token);
  const auth = () => ({ Authorization: `Bearer ${secret()}` });
  const notRunning = 'Agent Guild is not running on this computer. Ask the person to start it with `agent-guild` (or `agent-guild --no-browser`).';

  async function health() {
    try {
      const res = await fetch(`${base()}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
      const body = res.ok ? await res.json() : null;
      return body?.name === 'agent-guild' ? body : null;
    } catch {
      return null;
    }
  }

  const noSession = (id) => `No session has the id "${id}". Call list_sessions for the current ids.`;

  async function api(path, { method = 'GET', body, session, timeoutMs = REQUEST_TIMEOUT_MS, late = 'Agent Guild did not answer in time. Try again.' } = {}) {
    const request = {
      method,
      headers: { ...auth(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    };
    let res;
    try {
      res = await fetch(`${base()}/api/v1${path}`, request);
    } catch (err) {
      throw new ToolError(err?.name === 'TimeoutError' ? late : notRunning);
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new ToolError('Agent Guild refused the access token. Ask the person to restart Agent Guild with `agent-guild restart`.');
    if (res.status === 404 && session) throw new ToolError(noSession(session));
    if (!res.ok) throw new ToolError(data.error?.message || `Agent Guild answered HTTP ${res.status}.`);
    return data;
  }

  /** Attach to a session's terminal until its first snapshot, then hand the socket and snapshot to `use`. */
  function withTerminal(id, use) {
    const ws = new WebSocket(`${base().replace(/^http/, 'ws')}/api/v1/sessions/${id}/terminal`, { headers: auth() });
    return new Promise((resolve, reject) => {
      const fail = (message) => { clearTimeout(timer); ws.terminate(); reject(new ToolError(message)); };
      const timer = setTimeout(() => fail('Agent Guild did not send the terminal in time.'), SCREEN_TIMEOUT_MS);
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === 'error') return fail(noSession(id));
        if (msg.type !== 'snapshot') return undefined;
        clearTimeout(timer);
        Promise.resolve(use(ws, msg)).then(resolve, reject).finally(() => ws.close());
        return undefined;
      });
      ws.on('unexpected-response', (_req, res) => fail(res.statusCode === 401 ? 'Agent Guild refused the access token.'
        : res.statusCode === 404 ? noSession(id) : `Agent Guild answered HTTP ${res.statusCode}.`));
      ws.on('error', () => fail(notRunning));
      ws.on('close', (code) => { if (code === 4404) fail(noSession(id)); });
    });
  }

  function redactor() {
    let key = '';
    try { key = secret(); } catch { /* no token to hide */ }
    const gap = '(?:[\\s│┃|]|\\\\[nrt])*';
    const spread = key && new RegExp(key.split('').join(gap), 'g');
    const windows = [];
    for (let i = 0; i + MIN_TOKEN_FRAGMENT <= key.length; i++) windows.push(key.slice(i, i + MIN_TOKEN_FRAGMENT).split('').join(gap));
    const fragments = windows.length ? new RegExp(`(?=(${windows.join('|')}))`, 'g') : null;
    const link = new RegExp(`#token=[0-9a-f](?:${gap}[0-9a-f]){0,63}(?![0-9A-Za-z])`, 'g');
    const hide = (match) => match.replace(/[^\n]+/g, HIDDEN);
    return (value) => {
      value = (spread ? value.replace(spread, hide) : value).replace(link, (match) => `#token=${hide(match.slice(7))}`);
      if (!fragments) return value;
      // Merge overlapping known-token windows so a clipped span is hidden in full,
      // including a final piece shorter than the minimum. Keep its original rows.
      let result = '', start = 0, end = 0;
      for (const match of value.matchAll(fragments)) {
        if (match.index > end) {
          result += hide(value.slice(start, end)) + value.slice(end, match.index);
          start = match.index;
        }
        end = Math.max(end, match.index + match[1].length);
      }
      return result + hide(value.slice(start, end)) + value.slice(end);
    };
  }

  return { health, api, withTerminal, redactor, notRunning, startTimeoutMs };
}

function checkId(id) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new ToolError('session_id must be a session id from list_sessions.');
  return id;
}

function summarize(s) {
  return {
    id: s.id,
    name: s.name,
    tool: s.provider?.tool ?? s.provider?.vendor ?? null,
    provider: s.provider?.id ?? null,
    cwd: s.cwd,
    status: s.status,
    label: s.label,
    working: s.status === 'running' && s.activity === 'active',
    model: s.model ? s.model.displayName || s.model.name : null,
    account: s.account?.id ?? null,
    task: s.task,
    agents: (s.agents ?? []).map((a) => ({ name: a.name, status: a.status, detail: a.detail ?? null })),
    hasReply: s.reply != null,
    startedAt: s.startedAt,
    exitCode: s.exitCode,
  };
}

/** The tool a person names, by id, command, tool name or vendor. */
function findProvider(providers, wanted) {
  const key = String(wanted ?? '').trim().toLowerCase();
  if (!key) return null;
  const names = (p) => [p.id, p.command, p.tool, p.vendor, p.command === '@shell' ? 'shell' : null]
    .filter(Boolean).map((n) => String(n).toLowerCase());
  return providers.find((p) => names(p).includes(key))
    ?? providers.find((p) => names(p).some((n) => n.split(/[\s-]+/)[0] === key))
    ?? null;
}

/** The visible screen of a snapshot, as text, from a headless terminal the same size. */
function screenText({ data, cols, rows }, redact) {
  const term = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  return new Promise((resolve) => {
    term.write(data, () => {
      const buffer = term.buffer.active;
      const all = [];
      for (let y = 0; y < buffer.length; y++) all.push(buffer.getLine(y)?.translateToString(true) ?? '');
      const lines = redact(all.join('\n')).split('\n').slice(buffer.viewportY, buffer.viewportY + term.rows);
      term.dispose();
      while (lines.length && !lines.at(-1).trim()) lines.pop();
      resolve(lines.join('\n'));
    });
  });
}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

export function createToolHandlers(client, { allowInput = false } = {}) {
  const handlers = {
    async guild_status() {
      const up = await client.health();
      if (!up) return text({ running: false, message: client.notRunning, install: 'npm install -g @oddessentials/agent-guild' });
      const [{ sessions = [] }, { providers = [] }] = await Promise.all([client.api('/sessions'), client.api('/providers')]);
      return text({
        running: true,
        version: up.version,
        sessions: sessions.length,
        running_sessions: sessions.filter((s) => s.status === 'running').length,
        working_sessions: sessions.filter((s) => s.status === 'running' && s.activity === 'active').length,
        tools: providers.map((p) => ({ provider: p.id, tool: p.tool, installed: p.available === true })),
      });
    },
    async list_sessions() {
      const { sessions = [] } = await client.api('/sessions');
      if (!sessions.length) return text('Agent Guild has no sessions.');
      return text(sessions.map(summarize));
    },
    async read_reply({ session_id: id }) {
      const { reply } = await client.api(`/sessions/${checkId(id)}/reply`, { session: id });
      return text(reply?.text ?? 'This session has no finished reply yet. read_screen shows its terminal.');
    },
    async read_screen({ session_id: id }) {
      return text(await client.withTerminal(checkId(id), (_ws, snapshot) => screenText(snapshot, client.redactor())) || '(The screen is blank.)');
    },
    async start_session({ tool, cwd, name, account, resume }) {
      let resumeId = null;
      try { resumeId = resume ? cleanResumeId(resume) : null; } catch (err) { throw new ToolError(err.message); }
      const { providers = [] } = await client.api('/providers');
      const provider = findProvider(providers, tool);
      if (!provider) {
        throw new ToolError(`Agent Guild has no tool called "${tool}". It has: ${providers.map((p) => `${p.id} (${p.tool})`).join(', ')}.`);
      }
      if (provider.available === false) {
        throw new ToolError(`${provider.tool} is not installed. The person can install it from its card in Agent Guild${provider.install ? `, or with: ${provider.install}` : ''}.`);
      }
      // No `args`: launch flags such as --dangerously-skip-permissions are the person's to choose on the card.
      const body = { providerId: provider.id };
      for (const [key, value] of Object.entries({ cwd, name, account, resume: resumeId })) if (value) body[key] = String(value);
      const { session } = await client.api('/sessions', {
        method: 'POST',
        body,
        timeoutMs: client.startTimeoutMs,
        late: 'Agent Guild did not finish starting the session in time, so whether it started is unknown: it may still appear. Call list_sessions before starting another.',
      });
      return text({ started: true, session: summarize(session) });
    },
    async stop_session({ session_id: id }) {
      const { session } = await client.api(`/sessions/${checkId(id)}/stop`, { method: 'POST', session: id });
      return text({ stopped: true, session: summarize(session) });
    },
  };
  if (allowInput) {
    handlers.send_input = async ({ session_id: id, text: typed, submit = true }) => {
      if (typeof typed !== 'string') throw new ToolError('text must be a string.');
      await client.withTerminal(checkId(id), (ws, snapshot) => new Promise((resolve, reject) => {
        if (snapshot.session?.status !== 'running') throw new ToolError(`Session "${id}" has exited, so nothing was typed. start_session starts a new one.`);
        ws.send(JSON.stringify({ type: 'input', data: typed + (submit ? '\r' : '') }), (err) => (err ? reject(new ToolError('The terminal closed before the text was sent.')) : resolve()));
      }));
      return text({ sent: true });
    };
  }
  return handlers;
}

/**
 * Serve MCP over newline-delimited JSON-RPC. Resolves when `input` ends.
 * Only protocol messages go to `output`; nothing else may be written there.
 */
export function serveMcp({ input = process.stdin, output = process.stdout, allowInput = false, client = createGuildClient() } = {}) {
  const tools = allowInput ? [...TOOLS, INPUT_TOOL] : TOOLS;
  const handlers = createToolHandlers(client, { allowInput });
  const hide = (value, redact) => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map((item) => hide(item, redact));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hide(item, redact)]));
    return value;
  };
  const send = ({ id, ...body }) => output.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...hide(body, client.redactor()) })}\n`);
  const logError = (err) => console.error('[agent-guild mcp]', client.redactor()(String(err?.stack ?? err)));

  async function call(name, args) {
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    try {
      return { result: await handler(args ?? {}) };
    } catch (err) {
      if (err instanceof ToolError) return { result: { ...text(err.message), isError: true } };
      logError(err);
      return { result: { ...text('Agent Guild could not complete that request.'), isError: true } };
    }
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    const respond = id !== undefined && id !== null;
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return respond && send({ id, result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'agent-guild', title: 'Agent Guild', version: VERSION, websiteUrl: 'https://github.com/oddessentials/agent-guild/blob/main/docs/mcp.md' },
          instructions: INSTRUCTIONS,
        } });
      }
      case 'ping': return respond && send({ id, result: {} });
      case 'tools/list': return respond && send({ id, result: { tools } });
      case 'tools/call': {
        const outcome = await call(params?.name, params?.arguments);
        return respond && send({ id, ...outcome });
      }
      default:
        // Notifications, such as notifications/initialized, need no answer.
        return respond && send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }

  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const isObject = msg !== null && typeof msg === 'object' && !Array.isArray(msg);
    if (!isObject || typeof msg.method !== 'string') {
      // Responses are ignored: this server sends no requests of its own.
      if (!isObject || !('result' in msg || 'error' in msg)) send({ id: isObject ? msg.id ?? null : null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const job = handle(msg).catch(logError).finally(() => pending.delete(job));
    pending.add(job);
  });
  return new Promise((resolve) => lines.once('close', () => Promise.allSettled([...pending]).then(() => resolve())));
}
