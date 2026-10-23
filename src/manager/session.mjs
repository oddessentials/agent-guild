// One terminal session: a node-pty process, a headless terminal that mirrors
// its screen (so a reconnecting client gets the current screen, not a raw
// byte replay), and the sub-agents and model the coding tool has reported.

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import { killWindowsTree } from './command-resolver.mjs';
import { loadPty } from './pty.mjs';
import { dictatedText } from '../../web/dictation.js';

const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;

export const OSC_AGENT_CODE = 7777;
export const OSC_AGENT_PREFIX = 'agent-guild;';
const AGENT_STATUSES = new Set(['working', 'waiting', 'idle', 'done']);
const MODEL_SOURCE_RANK = { args: 0, screen: 1, report: 2 };
const SCREEN_SCAN_DELAY_MS = 400;
const SCREEN_SCAN_MAX_DELAY_MS = 2000;
const MAX_TOOL_SESSION_ID = 200;
const COMPACTIONS = new Set(['manual', 'auto']);
const RESET_SOURCES = new Set(['clear', 'startup', 'new']);
const MAX_COMPACTION_KEYS = 16;
const REPORTING_STATES = new Set(['pending', 'active', 'unavailable', 'setup_required', 'unsupported']);
const SHELL_EVENTS = new Set(['start', 'waiting', 'asked', 'background', 'end', 'running', 'reset']);
// A shell command, or a monitor: a watch the tool keeps in the background and reacts to.
const SHELL_KINDS = new Set(['shell', 'monitor']);
const MAX_SHELLS = 256;
const MAX_ENDED_TASKS = 256;
// Keys and reports a terminal sends as escape sequences: X10 mouse reports (three raw bytes after ESC [ M), other CSI
// and SS3 sequences, OSC and DCS strings (to their end, or the next ESC, so a large paste is scanned once), and ESC
// with one character (Alt+key). Bracketed paste markers are CSI, so pasted text is kept.
const ESCAPE_SEQUENCE = /\x1b\[M[\s\S]{3}|\x1b\[[0-?]*[ -/]*[@-~]|\x1bO[\s\S]|\x1b[\]P][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[\s\S]?/g;

/**
 * Colours reported to programs that query them (OSC 10/11/12), matching the
 * web page's terminal theme. Tools use these to choose light or dark output.
 */
export const REPORTED_COLORS = { 10: '#e6e9ef', 11: '#0f1115', 12: '#e6e9ef' };

function oscColor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => hex.slice(i, i + 2));
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

/** Clean a user-supplied session name: a trimmed string of at most 80 chars. */
export function cleanName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 80) : '';
}
const MAX_AGENTS = 64;

export function clampDimension(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** The label a session's card shows; every client shows this one. */
export function sessionLabel({ status, multiplexer, signal, exitCode, activity }) {
  if (status === 'exited') {
    // A multiplexer's client exits 1 when detached by Stop: its exit code tells the user nothing.
    if (multiplexer) return 'Closed';
    if (signal) return `Exited (${signal})`;
    return exitCode === 0 || exitCode === null ? 'Exited' : `Exited (${exitCode})`;
  }
  return activity === 'active' ? 'Working' : 'Running';
}

export class Session extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {object} opts.provider   provider description (id, vendor, tool, color, ...)
   * @param {{file: string, args: string[]|string}} opts.spawnSpec
   * @param {string} opts.cwd
   * @param {object} opts.env
   * @param {number} opts.cols
   * @param {number} opts.rows
   * @param {string} [opts.name]
   * @param {string|null} [opts.resume]  id of the tool's own session being resumed
   * @param {string|null} [opts.task]    "install" for a package install, "upgrade" for the manager's own, "clone" for a GitHub clone, else null
   * @param {{id: string, label: string}|null} [opts.account]  the tool sign-in the session runs under
   * @param {{repo: string, path: string, accountId: number}|null} [opts.clone]  what a clone session clones, and where
   * @param {{label: string, attach: string, reattachable: boolean}|null} [opts.multiplexer]  the multiplexer a Shell session runs in, and the command that reattaches it
   * @param {string} [opts.createdAt]  when the card was first made; a restored tmux or herdr card keeps its own. With no spawnSpec, the session is such a card, closed
   * @param {string} opts.reportToken
   * @param {number} [opts.scrollback]
   * @param {number} [opts.activityIdleMs]
   * @param {number} [opts.doneAgentLingerMs]
   * @param {number} [opts.killGraceMs]  time between hang-up and force kill
   * @param {number} [opts.submitDelayMs]  time between the text and Enter of a send
   */
  constructor(opts) {
    super();
    this.id = opts.id;
    this.provider = opts.provider;
    this.name = cleanName(opts.name) || opts.provider.tool;
    this.resume = opts.resume ?? null;
    this.task = opts.task ?? null;
    this.account = opts.account ?? null;
    this.clone = opts.clone ?? null;
    this.multiplexer = opts.multiplexer ?? null;
    this.cwd = opts.cwd;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.reportToken = opts.reportToken;
    this.scrollback = opts.scrollback ?? 5000;
    this.activityIdleMs = opts.activityIdleMs ?? 2500;
    this.doneAgentLingerMs = opts.doneAgentLingerMs ?? 15000;
    this.killGraceMs = opts.killGraceMs ?? 4000;
    this.reportingTimeoutMs = opts.reportingTimeoutMs ?? 30000;
    this.submitDelayMs = opts.submitDelayMs ?? 250;
    this._runs = 0;
    this._inputs = 0;
    this._sending = false;
    this.reporting = REPORTING_STATES.has(opts.reporting?.state) ? { state: opts.reporting.state, reason: opts.reporting.reason ?? null } : null;
    this._reportingTimer = null;
    this._typedSinceEnter = false;
    this.shellDisplayDelayMs = opts.shellDisplayDelayMs ?? 600;
    this.shells = new Map();
    this._shellSeq = 0;
    this._endedTasks = new Set();
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    /** When the current process started; later than createdAt once a multiplexer session is reattached. */
    this.startedAt = this.createdAt;
    this.exitedAt = null;
    this.status = 'running';
    this.exitCode = null;
    this.signal = null;
    this.activity = 'quiet';
    this.lastOutputAt = null;
    this.agents = new Map();
    this.model = null;
    this.toolSessionId = null;
    this.reply = null;
    this._replies = 0;
    this.context = { compactions: count(opts.context?.compactions), resets: count(opts.context?.resets) };
    this.compactionRepeatMs = opts.compactionRepeatMs ?? 2000;
    this._compactionKeys = [];
    this._compactedAt = -Infinity;
    this.modelRegex = null;
    if (opts.provider.modelPattern && this.task === null) {
      try {
        this.modelRegex = new RegExp(opts.provider.modelPattern, 'gi');
      } catch (err) {
        queueMicrotask(() => this.emit('warning', `ignoring modelPattern: ${err.message}`));
      }
    }
    this.subscribers = new Set();
    this.sizeOwner = null;
    this.sizeGeneration = 0;
    this._activityTimer = null;
    this._agentTimers = new Map();
    this._killTimer = null;
    this._scanTimer = null;
    this._scanDeadline = null;
    /** Resolves when the process has exited, even after dispose(). */
    this.exited = new Promise((resolve) => { this._resolveExited = resolve; });

    this.term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.parser.registerOscHandler(OSC_AGENT_CODE, (payload) => {
      this._handleOscReport(payload);
      return true;
    });
    // The mirror is the terminal of record: it answers the program's queries
    // (cursor position, device attributes, modes, colours) exactly once,
    // whether zero or several clients are attached. Clients must not answer.
    this.term.onData((reply) => this._reply(reply));
    for (const code of Object.keys(REPORTED_COLORS)) {
      this.term.parser.registerOscHandler(Number(code), (payload) => {
        if (payload !== '?') return false;
        this._reply(`\x1b]${code};${oscColor(REPORTED_COLORS[code])}\x1b\\`);
        return true;
      });
    }

    this.disposed = false;
    this.env = opts.env;
    if (!opts.spawnSpec) {
      // A tmux or herdr card brought back after the manager restarted: its
      // multiplexer still runs the session, and the card is closed until reattached.
      this.status = 'exited';
      this.exitedAt = new Date().toISOString();
      this.activity = 'quiet';
      this._resolveExited();
      const label = this.multiplexer?.label ?? 'The multiplexer';
      this.term.write(`\x1b[2m[Agent Guild restarted. ${label} still runs this session; Reattach it from its card.]\x1b[0m\r\n`);
      return;
    }
    try {
      this._start(opts.spawnSpec);
    } catch (err) {
      this.term.dispose();
      throw err;
    }
  }

  _start(spawnSpec, cwd = this.cwd) {
    const proc = loadPty().spawn(spawnSpec.file, spawnSpec.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd,
      env: this.env,
      useConpty: true,
    });
    this.pty = proc;
    this._runs++;
    proc.onData((data) => { if (this.pty === proc) this._onData(data); });
    proc.onExit(({ exitCode, signal }) => { if (this.pty === proc) this._onExit(exitCode, signal); });
  }

  /**
   * Run a new process in an exited session, keeping its id, report token and
   * screen: a multiplexer's client attaching to its session again, in `cwd`.
   */
  reattach(spawnSpec, { cwd = this.cwd } = {}) {
    if (this.disposed || this.status !== 'exited') throw Object.assign(new Error('only an exited session can be reattached'), { status: 409 });
    this._start(spawnSpec, cwd);
    Object.assign(this, { status: 'running', exitCode: null, signal: null, exitedAt: null, activity: 'quiet', startedAt: new Date().toISOString() });
    this.exited = new Promise((resolve) => { this._resolveExited = resolve; });
    this._changed();
  }

  /**
   * Read live: on Windows node-pty connects the console asynchronously and
   * reports pid 0 until then. The first output announces the session again.
   */
  get pid() {
    return this.status === 'running' && !this.disposed ? this.pty.pid || null : null;
  }

  // ---- terminal I/O ------------------------------------------------------

  _onData(data) {
    if (this.disposed) return;
    this.term.write(data);
    this._broadcast({ type: 'data', data });
    this.lastOutputAt = Date.now();
    if (this.modelRegex && this.model?.source !== 'report') this._scheduleModelScan();
    if (this.activity !== 'active') {
      this.activity = 'active';
      this._changed();
    }
    clearTimeout(this._activityTimer);
    this._activityTimer = setTimeout(() => {
      this.activity = 'quiet';
      this._changed();
    }, this.activityIdleMs);
    this._activityTimer.unref?.();
  }

  _onExit(exitCode, signal) {
    clearTimeout(this._killTimer);
    this._resolveExited();
    if (this.disposed) return;
    this.exitedAt ??= new Date().toISOString();
    this.status = 'exited';
    this.exitCode = exitCode ?? null;
    this.signal = signal || null;
    this.activity = 'quiet';
    clearTimeout(this._activityTimer);
    clearTimeout(this._killTimer);
    clearTimeout(this._scanTimer);
    clearTimeout(this._reportingTimer);
    this._clearAgents();
    this._clearShells();
    // Let the headless terminal finish parsing before announcing the exit so
    // any client attaching afterwards still sees the final screen.
    this.term.write('', () => {
      this._broadcast({ type: 'exit', exitCode: this.exitCode, signal: this.signal });
      this._changed();
      this.emit('exit', this);
    });
  }

  _broadcast(message) {
    for (const sub of this.subscribers) {
      if (sub.pending) sub.pending.push(message);
      else sub.send(message);
    }
  }

  /**
   * Attach a client. `send` receives protocol messages. The first message is
   * always a `snapshot` of the current screen; output produced while the
   * snapshot is being built is queued and delivered right after it.
   * Returns a detach function.
   */
  attach(send, { page = null } = {}) {
    const sub = { send, page, pending: [] };
    this.subscribers.add(sub);
    // Everything written to the mirror before this marker is in the snapshot;
    // everything after it is queued in sub.pending.
    this.term.write('', () => {
      if (!this.subscribers.has(sub)) return;
      send({
        type: 'snapshot',
        data: this._serializeScreen(),
        cols: this.term.cols,
        rows: this.term.rows,
        ...this._sizeFor(page),
        session: this.toJSON(),
      });
      const queued = sub.pending;
      sub.pending = null;
      for (const message of queued) send(message);
      if (this.status === 'exited' && !queued.some((m) => m.type === 'exit')) {
        send({ type: 'exit', exitCode: this.exitCode, signal: this.signal });
      }
    });
    this._changed();
    return () => {
      if (this.subscribers.delete(sub)) this._changed();
    };
  }

  /**
   * The current screen as a VT stream. The serialize addon restores the
   * buffers and most modes; cursor visibility and the mouse encoding are
   * added here because it omits them.
   */
  _serializeScreen() {
    let data = this.serializer.serialize({ scrollback: this.scrollback });
    const core = this.term._core;
    if (core?.coreService?.isCursorHidden) data += '\x1b[?25l';
    const encoding = core?.coreMouseService?.activeEncoding;
    if (encoding === 'SGR') data += '\x1b[?1006h';
    else if (encoding === 'SGR_PIXELS') data += '\x1b[?1016h';
    return data;
  }

  write(data) {
    if (this.disposed || this.status !== 'running' || typeof data !== 'string' || data.length === 0) return;
    try { this.pty.write(data); } catch { /* process is exiting */ }
  }

  input(data) {
    this._inputs++;
    this.write(data);
    if (this.reporting?.state === 'pending' && !this._reportingTimer && typeof data === 'string' && this._sendsTypedLine(data)) {
      this._reportingTimer = setTimeout(() => {
        if (this.reporting?.state !== 'pending' || this.status !== 'running') return;
        this.reporting = {
          state: 'unavailable',
          reason: `No report from ${this.provider.tool}'s hooks yet. They report once a prompt is sent; that can wait while ${this.provider.tool} signs in or sets up. If a prompt was sent and this stays, its hooks may be turned off, restricted by an administrator, or not trusted for this folder.`,
        };
        this._changed();
      }, this.reportingTimeoutMs);
      this._reportingTimer.unref?.();
    }
  }

  /**
   * Enter `text` as the page's Dictate does, pasted as one line, then press Enter `submitDelayMs` later, as a person
   * would: a program may read an Enter that follows a paste too closely as a new line, as Codex CLI does. Enter is
   * pressed only into the same run of the session, and only if no other input arrived in between.
   */
  async send(text) {
    if (typeof text !== 'string') throw refusal(400, 'bad_text', 'text must be a string');
    const line = dictatedText(text, true);
    if (!line) throw refusal(400, 'bad_text', 'text has nothing to send');
    if (this.disposed || this.status !== 'running') throw refusal(409, 'session_exited', 'session has exited');
    // A second text typed in the wait would be submitted with the first.
    if (this._sending) throw refusal(409, 'send_in_progress', 'another send to this session has not pressed Enter yet');
    this._sending = true;
    try {
      // What xterm.js's paste sends for one line of text.
      this.input(this.term.modes.bracketedPasteMode ? `\x1b[200~${line}\x1b[201~` : line);
      const { _runs: run, _inputs: inputs } = this;
      await new Promise((resolve) => setTimeout(resolve, this.submitDelayMs));
      if (this.disposed || this.status !== 'running' || this._runs !== run) {
        throw refusal(409, 'session_exited', 'session exited before Enter; the text was not submitted');
      }
      if (this._inputs !== inputs) {
        throw refusal(409, 'input_interrupted', 'other input reached the session before Enter; the text was typed but not submitted');
      }
      this.input('\r');
    } finally {
      this._sending = false;
    }
  }

  /**
   * Whether this input sends a line with something typed on it, the way a
   * prompt is sent. An Enter on an empty line, or after only keys that send
   * escape sequences (arrows in a menu, focus and mouse reports), is not a
   * prompt; nor is one after Ctrl+C or Ctrl+U, which clear the line. Text
   * may arrive one key at a time, so what was typed carries over.
   */
  _sendsTypedLine(data) {
    const keys = data.replace(ESCAPE_SEQUENCE, '');
    let sent = false;
    for (const ch of keys) {
      if (ch === '\r' || ch === '\n') {
        sent ||= this._typedSinceEnter;
        this._typedSinceEnter = false;
      } else if (ch === '\x03' || ch === '\x15') this._typedSinceEnter = false;
      else if (ch >= ' ' && ch !== '\x7f') this._typedSinceEnter = true;
    }
    return sent;
  }

  _reply(data) {
    this.write(data);
  }

  claimSize(page, cols, rows) {
    if (this.disposed || !page) return false;
    this.sizeOwner = page;
    this.sizeGeneration++;
    this._setSize(cols, rows);
    this._broadcastSize();
    return true;
  }

  resizeFrom(page, generation, cols, rows) {
    if (this.disposed || !page) return false;
    const accepted = page === this.sizeOwner && generation === this.sizeGeneration;
    if (accepted) this._setSize(cols, rows);
    // Answered even when nothing changed or the resize is refused: the page waits for it before sending its next size.
    this._broadcastSize(accepted ? null : page);
    return accepted;
  }

  _sizeFor(page) {
    return { generation: this.sizeGeneration, owner: Boolean(page) && page === this.sizeOwner };
  }

  _broadcastSize(onlyPage = null) {
    for (const sub of this.subscribers) {
      if (onlyPage && sub.page !== onlyPage) continue;
      const message = { type: 'resize', cols: this.cols, rows: this.rows, ...this._sizeFor(sub.page) };
      if (sub.pending) sub.pending.push(message);
      else sub.send(message);
    }
  }

  _setSize(cols, rows) {
    const c = clampDimension(cols, this.cols, 2, 1000);
    const r = clampDimension(rows, this.rows, 1, 500);
    if (c === this.cols && r === this.rows) return;
    this.cols = c;
    this.rows = r;
    // The mirror may still be parsing output written before the resize; the size lands after it, as it did in the PTY.
    this.term.write('', () => { if (!this.disposed) this.term.resize(c, r); });
    if (this.status === 'running') {
      try { this.pty.resize(c, r); } catch { /* process may be exiting */ }
    }
  }

  /**
   * End the process. On macOS and Linux: hang-up first, force after a grace
   * period. On Windows: end the whole process tree at once, except for a
   * multiplexer's client, whose server is its child there and must outlive
   * it. node-pty's own Windows kill first asks a helper process for the
   * console's process list, and when that helper fails it waits a fixed
   * five seconds.
   */
  kill({ graceMs = this.killGraceMs } = {}) {
    if (this.status !== 'running') return;
    if (process.platform === 'win32') {
      this._killWindowsTree();
      return;
    }
    const force = () => { try { this.pty.kill('SIGKILL'); } catch { /* gone */ } };
    try { this.pty.kill('SIGHUP'); } catch { force(); }
    clearTimeout(this._killTimer);
    this._killTimer = setTimeout(force, graceMs);
    this._killTimer.unref?.();
  }

  _killWindowsTree() {
    const fallback = () => {
      if (this.status === 'running') { try { this.pty.kill(); } catch { /* gone */ } }
    };
    const pid = this.pty.pid;
    if (!pid) return fallback();
    killWindowsTree(pid, (err) => { if (err) fallback(); }, { tree: !this.multiplexer });
  }

  /**
   * Detach everything. A still-running process gets the normal hang-up and
   * is force-killed after the grace period if it ignores it.
   */
  dispose({ graceMs } = {}) {
    if (this.disposed) return;
    this.kill(graceMs === undefined ? {} : { graceMs });
    this.disposed = true;
    clearTimeout(this._activityTimer);
    clearTimeout(this._scanTimer);
    clearTimeout(this._reportingTimer);
    this._clearShells();
    for (const t of this._agentTimers.values()) clearTimeout(t);
    this.subscribers.clear();
    this.term.dispose();
  }

  rename(name) {
    const clean = cleanName(name);
    if (!clean) return;
    this.name = clean;
    this._changed();
  }

  // ---- sub-agents --------------------------------------------------------

  /**
   * Record a report about an agent working inside this session. `status`
   * "done" (or `remove: true`) removes it after a short linger so the UI can
   * show it finishing. Returns the stored agent or null when removed.
   */
  reportAgent(report, source = 'api') {
    if (!report || typeof report !== 'object') throw badRequest('agent report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (source === 'api') this._reportingHeard();
    if (report.finishForeground === true && report.agentId === undefined) {
      this._endForegroundShells(null);
      return null;
    }
    const id = String(report.agentId ?? report.agent ?? report.id ?? '').trim().slice(0, 128);
    if (!id) throw badRequest('agentId is required');

    if (report.remove === true) {
      this._removeAgent(id);
      return null;
    }
    const status = report.status === undefined ? 'working' : String(report.status);
    if (!AGENT_STATUSES.has(status)) {
      throw badRequest(`status must be one of ${[...AGENT_STATUSES].join(', ')}`);
    }
    const now = new Date().toISOString();
    const existing = this.agents.get(id);
    if (status === 'done') this._endForegroundShells(id);
    // A first report that already says done would only flash an icon:
    // Claude Code's internal helpers (prompt suggestions, side questions)
    // stop without ever having started here.
    if (!existing && status === 'done') return null;
    // A repeated done (Grok Build ends a sub-agent's session after its
    // turn) must not restart the linger.
    if (existing?.status === 'done' && status === 'done') return existing;
    if (!existing && this.agents.size >= MAX_AGENTS && !this._evictDoneAgent()) {
      throw badRequest(`too many agents (max ${MAX_AGENTS})`);
    }
    const agent = {
      id,
      name: String(report.name ?? existing?.name ?? id).slice(0, 80),
      kind: String(report.kind ?? existing?.kind ?? 'agent').slice(0, 40),
      status,
      detail: report.detail === undefined ? existing?.detail ?? '' : String(report.detail).slice(0, 200),
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      source,
    };
    this.agents.set(id, agent);
    clearTimeout(this._agentTimers.get(id));
    this._agentTimers.delete(id);
    if (status === 'done') {
      const timer = setTimeout(() => this._removeAgent(id), this.doneAgentLingerMs);
      timer.unref?.();
      this._agentTimers.set(id, timer);
    }
    this._changed();
    return agent;
  }

  _removeAgent(id) {
    clearTimeout(this._agentTimers.get(id));
    this._agentTimers.delete(id);
    if (this.agents.delete(id)) this._changed();
  }

  /** Drop the done agent that has lingered longest, to make room. */
  _evictDoneAgent() {
    let oldest = null;
    for (const agent of this.agents.values()) {
      if (agent.status === 'done' && (!oldest || agent.updatedAt < oldest.updatedAt)) oldest = agent;
    }
    if (!oldest) return false;
    this._removeAgent(oldest.id);
    return true;
  }

  _clearAgents() {
    for (const t of this._agentTimers.values()) clearTimeout(t);
    this._agentTimers.clear();
    this.agents.clear();
  }

  _handleOscReport(payload) {
    if (!payload.startsWith(OSC_AGENT_PREFIX)) return;
    try {
      const report = JSON.parse(payload.slice(OSC_AGENT_PREFIX.length));
      const isAgent = report && typeof report === 'object' &&
        ((report.agentId ?? report.agent ?? report.id) !== undefined || report.finishForeground === true);
      if (isAgent) this.reportAgent(report, 'terminal');
      else if (report?.toolSessionId !== undefined) this.reportToolSession(report, 'terminal');
      else this.reportModel(report, 'terminal');
    } catch (err) {
      this.emit('warning', `ignored in-band report: ${err.message}`);
    }
  }

  // ---- shells ------------------------------------------------------------

  reportShell(report) {
    if (!report || typeof report !== 'object') throw badRequest('shell report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (!SHELL_EVENTS.has(report.shell)) throw badRequest(`shell must be one of ${[...SHELL_EVENTS].join(', ')}`);
    const id = (value) => (typeof value === 'string' && value ? value.slice(0, 128) : null);
    const key = id(report.key);
    const task = id(report.task);
    const match = typeof report.match === 'string' && /^[a-f0-9]{32}$/.test(report.match) ? report.match : null;
    const agentId = id(report.agentId);
    const kindOf = (value) => {
      if (value === undefined) return 'shell';
      if (!SHELL_KINDS.has(value)) throw badRequest(`kind must be one of ${[...SHELL_KINDS].join(', ')}`);
      return value;
    };
    this._reportingHeard();

    if (report.shell === 'reset') {
      for (const shell of [...this.shells.values()]) this._endShell(shell);
      return null;
    }

    if (report.shell === 'running') {
      if (!Array.isArray(report.tasks)) throw badRequest('a running report needs a tasks array');
      const running = new Map();
      for (const entry of report.tasks.slice(0, MAX_SHELLS)) {
        const task = id(entry?.id);
        if (task) running.set(task, kindOf(entry.kind));
      }
      for (const shell of [...this.shells.values()]) {
        if (!shell.task) continue;
        if (!running.has(shell.task)) this._endShell(shell);
        // The list can promote a command to a monitor, never the reverse: Claude Code lists a monitor that runs a shell
        // command as a shell, and only the monitor's own background report tells them apart.
        else if (running.get(shell.task) === 'monitor') this._setKind(shell, 'monitor');
      }
      const known = new Set([...this.shells.values()].map((shell) => shell.task));
      for (const [each, kind] of running) if (!known.has(each) && !this._endedTasks.has(each)) this._addShell({ task: each, kind }, { now: true });
      return null;
    }

    if (report.shell === 'waiting' || report.shell === 'asked') {
      // A permission request carries no call id, and a PreToolUse hook may have rewritten its command: it belongs to the
      // agent's one foreground command with that command, else to its only one.
      const candidates = [...this.shells.values()].filter((shell) => shell.agentId === agentId && this._foreground(shell) && !shell.waiting && !shell.asked);
      const exact = match ? candidates.filter((shell) => shell.match === match) : [];
      const shell = exact.length === 1 ? exact[0] : exact.length === 0 && candidates.length === 1 ? candidates[0] : null;
      if (shell && report.shell === 'asked') {
        shell.asked = true;
      } else if (shell) {
        clearTimeout(shell.timer);
        shell.waiting = true;
        this._setVisible(shell, false);
      }
      return null;
    }

    if (report.shell === 'end') {
      if (!key && !task) throw badRequest('a shell end needs a key or a task');
      if (task) this._rememberEnded(task);
      const shell = (key && this._shellBy('key', key)) || (task && this._shellBy('task', task));
      if (shell) this._endShell(shell);
      return null;
    }

    if (!key) throw badRequest('a shell report needs a key');
    if (report.shell === 'start') {
      if (!this._shellBy('key', key)) this._addShell({ key, match, agentId, persist: report.persist === true });
      return null;
    }

    if (!task) throw badRequest('a background report needs a task');
    const kind = kindOf(report.kind);
    const shell = this._shellBy('key', key);
    if (!shell) return null;
    Object.assign(shell, { task, endsWithAgent: report.endsWithAgent === true });
    this._setKind(shell, kind);
    if (shell.waiting) {
      shell.waiting = false;
      this._showAfterDelay(shell);
    }
    return null;
  }

  _addShell(fields, { now = false } = {}) {
    if (this.shells.size >= MAX_SHELLS) {
      this.emit('warning', `ignored a shell command: ${MAX_SHELLS} are already running`);
      return;
    }
    const shell = {
      id: `shell-${++this._shellSeq}`, kind: 'shell', key: null, match: null, agentId: null, persist: false, task: null,
      endsWithAgent: false, waiting: false, asked: false, visible: false, timer: null, ...fields,
    };
    this.shells.set(shell.id, shell);
    if (now) this._setVisible(shell, true);
    else this._showAfterDelay(shell);
  }

  _showAfterDelay(shell) {
    clearTimeout(shell.timer);
    shell.timer = setTimeout(() => this._setVisible(shell, true), this.shellDisplayDelayMs);
    shell.timer.unref?.();
  }

  _setVisible(shell, visible) {
    if (shell.visible === visible) return;
    shell.visible = visible;
    this._changed();
  }

  _setKind(shell, kind) {
    if (shell.kind === kind) return;
    shell.kind = kind;
    if (shell.visible) this._changed();
  }

  _foreground(shell) {
    return shell.task === null;
  }

  _shellBy(field, value) {
    for (const shell of this.shells.values()) if (shell[field] === value) return shell;
    return null;
  }

  // A turn's foreground commands end with it; a background command, or one Codex CLI keeps running, does not.
  _endForegroundShells(agentId) {
    for (const shell of [...this.shells.values()]) {
      if (shell.agentId !== agentId) continue;
      const lasting = this._foreground(shell) ? shell.persist && !shell.asked : !(agentId && shell.endsWithAgent);
      if (!lasting) this._endShell(shell);
    }
  }

  _rememberEnded(task) {
    this._endedTasks.delete(task);
    this._endedTasks.add(task);
    if (this._endedTasks.size > MAX_ENDED_TASKS) this._endedTasks.delete(this._endedTasks.values().next().value);
  }

  _endShell(shell) {
    clearTimeout(shell.timer);
    if (shell.task) this._rememberEnded(shell.task);
    if (this.shells.delete(shell.id) && shell.visible) this._changed();
  }

  _clearShells() {
    for (const shell of this.shells.values()) clearTimeout(shell.timer);
    this.shells.clear();
  }

  // ---- model -------------------------------------------------------------

  /**
   * The main model the tool says it is using. Explicit reports win over
   * text seen on screen, which wins over a --model argument.
   */
  setModel({ name, displayName = null }, source) {
    if (this.model && MODEL_SOURCE_RANK[this.model.source] > MODEL_SOURCE_RANK[source]) return;
    const current = this.model;
    if (current && current.name === name && current.displayName === displayName && current.source === source) return;
    this.model = { name, displayName, source };
    this._changed();
  }

  reportModel(report, source = 'api') {
    if (!report || typeof report !== 'object') throw badRequest('model report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (source === 'api') this._reportingHeard();
    const name = String(report.model ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('model is required');
    const displayName = report.displayName === undefined || report.displayName === null ? null : String(report.displayName).trim().slice(0, 80) || null;
    this.setModel({ name, displayName }, 'report');
    return this.model;
  }

  reportToolSession(report, source = 'api') {
    if (!report || typeof report !== 'object') throw badRequest('tool session report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (source === 'api') this._reportingHeard();
    const id = String(report.toolSessionId ?? '').trim();
    if (!id || id.length > MAX_TOOL_SESSION_ID || /\p{Cc}/u.test(id)) throw badRequest(`toolSessionId must be a printable id of at most ${MAX_TOOL_SESSION_ID} characters`);
    if (this.toolSessionId !== id) {
      if (this.toolSessionId && RESET_SOURCES.has(report.source)) this.context.resets++;
      this.toolSessionId = id;
      this._changed();
    }
    return this.toolSessionId;
  }

  /** A compaction of the tool's context, counted once however many of its hooks report it. */
  reportContext(report) {
    if (!report || typeof report !== 'object') throw badRequest('context report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (!COMPACTIONS.has(report.compaction)) throw badRequest('compaction must be manual or auto');
    const key = report.key === undefined || report.key === null ? null : String(report.key).trim();
    if (key !== null && (!key || key.length > MAX_TOOL_SESSION_ID || /\p{Cc}/u.test(key))) throw badRequest(`key must be a printable id of at most ${MAX_TOOL_SESSION_ID} characters`);
    this._reportingHeard();
    if (key !== null) {
      if (this._compactionKeys.includes(key)) return this.context;
      this._compactionKeys = [...this._compactionKeys.slice(1 - MAX_COMPACTION_KEYS), key];
    } else {
      const now = Date.now();
      const repeat = now - this._compactedAt < this.compactionRepeatMs;
      this._compactedAt = now;
      if (repeat) return this.context;
    }
    this.context.compactions++;
    this._changed();
    return this.context;
  }

  /** The text of the agent's last answer, or null when its last turn ended without one. */
  reportReply(report) {
    if (!report || typeof report !== 'object') throw badRequest('reply report must be an object');
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    if (report.reply !== null && typeof report.reply !== 'string') throw badRequest('reply must be a string or null');
    this._reportingHeard();
    const text = report.reply?.trim() || null;
    this.reply = text ? { id: ++this._replies, text } : null;
    this._changed();
    return this.reply && { id: this.reply.id };
  }

  reportHello() {
    if (this.status !== 'running') throw Object.assign(new Error('session has exited'), { status: 409 });
    this._reportingHeard();
    return this.reporting;
  }

  _reportingHeard() {
    clearTimeout(this._reportingTimer);
    if (!this.reporting || this.reporting.state === 'active') return;
    this.reporting = { state: 'active', reason: null };
    this._changed();
  }

  /**
   * Scan shortly after output pauses, and at least every couple of seconds
   * while output keeps coming, so a busy tool still gets scanned.
   */
  _scheduleModelScan() {
    const now = Date.now();
    this._scanDeadline ??= now + SCREEN_SCAN_MAX_DELAY_MS;
    clearTimeout(this._scanTimer);
    const delay = Math.max(0, Math.min(SCREEN_SCAN_DELAY_MS, this._scanDeadline - now));
    this._scanTimer = setTimeout(() => this._scanScreenForModel(), delay);
    this._scanTimer.unref?.();
  }

  _scanScreenForModel() {
    this._scanDeadline = null;
    if (this.disposed || !this.modelRegex || this.model?.source === 'report') return;
    const buffer = this.term.buffer.active;
    const lines = [];
    for (let y = 0; y < this.term.rows; y++) lines.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '');
    let last = null;
    for (const match of lines.join('\n').matchAll(this.modelRegex)) last = match[0];
    if (last) this.setModel({ name: last.replace(/[.,;:)]+$/, '') }, 'screen');
  }

  // ---- state -------------------------------------------------------------

  _changed() {
    this.emit('changed', this);
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      provider: {
        id: this.provider.id,
        vendor: this.provider.vendor,
        tool: this.provider.tool,
        color: this.provider.color,
        monogram: this.provider.monogram,
        iconUrl: this.provider.iconUrl,
      },
      cwd: this.cwd,
      resume: this.resume,
      task: this.task,
      account: this.account,
      clone: this.clone,
      multiplexer: this.multiplexer,
      pid: this.pid,
      status: this.status,
      exitCode: this.exitCode,
      signal: this.signal,
      activity: this.activity,
      label: sessionLabel(this),
      lastOutputAt: this.lastOutputAt ? new Date(this.lastOutputAt).toISOString() : null,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      exitedAt: this.exitedAt,
      cols: this.cols,
      rows: this.rows,
      attachedClients: this.subscribers.size,
      model: this.model,
      toolSessionId: this.toolSessionId,
      context: { ...this.context },
      reply: this.reply && { id: this.reply.id },
      reporting: this.reporting,
      agents: [...this.agents.values()],
      shells: [...this.shells.values()].filter((s) => s.visible).map((s) => ({ id: s.id, kind: s.kind })),
    };
  }
}

function count(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

export function newId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}
