// The agents herdr sees in its panes, for a herdr card. herdr tracks every
// coding agent in its panes and whether it is working, blocked or idle, with
// no hooks of ours. Its socket API pushes an event when an agent appears or
// leaves and, for a pane named in the subscription, when its agent changes
// state; each event triggers a fresh agent.list, as herdr's documentation
// advises, since events and reads share no sequence.

import net from 'node:net';
import { buildSpawnSpec, runSpec } from './command-resolver.mjs';

const ANY_PANE = ['pane.agent_detected', 'pane.closed', 'pane.exited'];
const STATUS = { working: 'working', blocked: 'waiting' };
const REQUEST_TIMEOUT_MS = 10000;

/** Card agent reports for herdr's agent list. Idle, done and unknown agents show as idle. */
export function herdrAgentReports(agents) {
  return (Array.isArray(agents) ? agents : [])
    .filter((agent) => typeof agent?.pane_id === 'string' && typeof agent.agent === 'string')
    .map((agent) => ({
      agentId: `herdr:${agent.pane_id}`,
      name: agent.agent,
      kind: 'agent',
      status: STATUS[agent.agent_status] ?? 'idle',
      detail: typeof agent.cwd === 'string' ? agent.cwd : '',
    }));
}

/**
 * Where to reach the herdr session that a client started with `env` uses:
 * the one HERDR_SESSION names, else the default. herdr names its Windows
 * pipe after the socket path.
 */
export function herdrSocket(listing, env, platform = process.platform) {
  const sessions = Array.isArray(listing?.sessions) ? listing.sessions : [];
  const session = sessions.find((s) => (env.HERDR_SESSION ? s.name === env.HERDR_SESSION : s.default === true));
  if (!session?.running || typeof session.socket_path !== 'string') return null;
  return platform === 'win32' ? `\\\\.\\pipe\\${session.socket_path}` : session.socket_path;
}

/** Call `onLine` with each JSON line read from `socket`. */
function readLines(socket, onLine) {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      try { onLine(JSON.parse(line)); } catch { /* not JSON */ }
    }
  });
}

/** One request on its own connection: resolves with its result. */
function request(socketPath, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy(new Error(`herdr did not answer ${method}`)));
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'agent-guild', method, params })}\n`));
    readLines(socket, (msg) => {
      socket.end();
      if (msg.error) reject(new Error(msg.error.message || msg.error.code));
      else resolve(msg.result);
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error(`herdr closed the connection before answering ${method}`)));
  });
}

export class HerdrAgents {
  /**
   * @param {object} opts
   * @param {string} opts.herdr   the herdr executable
   * @param {object} opts.env     the environment the card's herdr client runs with
   * @param {(agents: object[]) => void} opts.onAgents  called with herdr's agent list after each change
   */
  constructor({ herdr, env, platform = process.platform, onAgents }) {
    Object.assign(this, { herdr, env, platform, onAgents });
    this.socketPath = null;
    this.subscription = null;
    this.panes = null;
    this.connecting = false;
    this.reading = false;
    this.readAgain = false;
    this.stopped = false;
  }

  /** Connect unless connected. A server that was still starting is found on a later call. */
  poke() {
    if (this.stopped || this.subscription || this.connecting) return;
    this.connecting = true;
    this._connect().finally(() => { this.connecting = false; });
  }

  stop() {
    this.stopped = true;
    this.subscription?.destroy();
    this.subscription = null;
  }

  async _connect() {
    try {
      const spec = buildSpawnSpec(this.herdr, ['session', 'list', '--json'], this.env, this.platform);
      const { stdout } = await runSpec(spec, { env: this.env, timeoutMs: REQUEST_TIMEOUT_MS });
      this.socketPath = herdrSocket(JSON.parse(stdout), this.env, this.platform);
    } catch {
      return;
    }
    if (this.socketPath && !this.stopped) this._subscribe([]);
  }

  /** Replace the subscription: any pane's agent arriving or leaving, and each of `panes` changing state. */
  _subscribe(panes) {
    this.subscription?.destroy();
    this.panes = panes;
    const socket = net.connect(this.socketPath);
    this.subscription = socket;
    const subscriptions = [...ANY_PANE.map((type) => ({ type })), ...panes.map((pane) => ({ type: 'pane.agent_status_changed', pane_id: pane }))];
    socket.on('connect', () => socket.write(`${JSON.stringify({ id: 'agent-guild', method: 'events.subscribe', params: { subscriptions } })}\n`));
    readLines(socket, (msg) => {
      if (this.subscription !== socket) return;
      // herdr refuses a subscription naming a pane that has closed, and ends one that fell behind;
      // start over from no panes. Anything else, the acknowledgement included, is a reason to read.
      if (msg.error) return panes.length ? this._subscribe([]) : socket.destroy();
      this._read();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.subscription === socket) this.subscription = null;
    });
  }

  /** Read herdr's agent list, once more if an event arrives meanwhile, and follow the panes it names. */
  async _read() {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.readAgain = false;
        const { agents = [] } = (await request(this.socketPath, 'agent.list')) ?? {};
        if (this.stopped) return;
        this.onAgents(agents);
        const panes = agents.map((agent) => agent?.pane_id).filter((pane) => typeof pane === 'string').sort();
        if (this.subscription && panes.join('\n') !== this.panes.join('\n')) this._subscribe(panes);
      } while (this.readAgain && !this.stopped);
    } catch {
      // herdr went away or did not answer; the next event or poke tries again.
    } finally {
      this.reading = false;
    }
  }
}
