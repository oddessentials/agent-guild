// Which Docker Agent session each of its hook events belongs to, decided from evidence only.
//
// One Docker Agent process runs several sessions: the one in each TUI tab (/new, /clear, /fork and /sessions change
// them), and one per sub-agent (transfer_task, run_background_agent, run_skill). Their hook events differ only by
// session_id, so the card learns what each session is from three facts about Docker Agent (measured on v1.55.0 and
// v1.149.0):
// - A top-level session's row is in session.db before its run's session_start hook, and its every run (a prompt, a
//   retry) starts with session_start. Only a user action starts a top-level run.
// - A sub-agent's row is written only after it ends, with its parent set, and its own session_start comes after the
//   parent's delegation call is saved, under a call id of its own.
// - Hook command arguments are not inherited, so only events carrying this launch's nonce come from the card's own
//   Docker Agent process; a nested `docker agent`, or a global hooks.d file, cannot carry it.
//
// A session is main-level (its commands show on the card's main agent) once a nonce-carrying event finds its top-level
// row, and a sub-agent once one finds no row but an unmatched delegation call saved in a main-level session during its
// current run. Anything else stays provisional: its commands show on the main agent, it never gets an agent card or
// moves Resume, it is checked again at each of its events, and it is forgotten when it ends unclassified. Resume
// targets the most recently started confirmed top-level session: only a nonce-carrying session_start of a top-level
// session moves it, so late events, other tabs' running turns, sub-agents and database failures never do.

import os from 'node:os';
import path from 'node:path';
import { dockerAgentDataDir, loadSqlite } from './session-history.mjs';
import { compareVersions } from './versions.mjs';

// The tool calls that run a sub-agent, and the agent each one runs: a skill runs as its caller.
const DELEGATIONS = {
  transfer_task: (args) => args.agent,
  run_background_agent: (args) => args.agent,
  run_skill: (_args, caller) => caller,
};
const SHELL_TOOL = 'shell';
const MAX_SESSIONS = 512;

// Before v1.101.0 the store is always ~/.cagent/session.db; from then it is in the data folder, which --data-dir moves.
export const DOCKER_DATA_DB_VERSION = '1.101.0';

/**
 * The session store a `docker agent run` with these arguments uses, as `version` (null: the latest) resolves it:
 * --session-db (-s); else, from v1.101.0, the --data-dir folder's; else the data folder's.
 */
export function dockerSessionDb(args, env = process.env, version = null) {
  const value = (names) => {
    for (let i = 0; i < args.length; i++) {
      if (names.includes(args[i])) return args[i + 1] || null;
      const joined = names.find((name) => name.startsWith('--') && args[i].startsWith(`${name}=`));
      if (joined) return args[i].slice(joined.length + 1) || null;
    }
    return undefined;
  };
  const home = (file) => file.replace(/^~(?=$|[\\/])/, os.homedir());
  const db = value(['--session-db', '-s']);
  if (db !== undefined) return db && home(db);
  if (version && compareVersions(version, DOCKER_DATA_DB_VERSION) < 0) return path.join(os.homedir(), '.cagent', 'session.db');
  const dir = value(['--data-dir']);
  if (dir) return path.join(home(dir), 'session.db');
  return path.join(dockerAgentDataDir(env, version), 'session.db');
}

/** Opens Docker Agent's session store read-only; each call reads it as it is now. */
export async function openSessionStore(file) {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  return {
    /** The session's parent, '' for a top-level session, or undefined when the store has no row for it. */
    parentOf(id) {
      const row = db.prepare('select parent_id from sessions where id = ?').get(id);
      return row === undefined ? undefined : row.parent_id || '';
    },
    /** The highest item position the session has saved, or -1. */
    lastPosition(id) {
      return db.prepare('select max(position) as last from session_items where session_id = ?').get(id)?.last ?? -1;
    },
    /** Delegation calls the session saved after `after`, in order: { callId, agent, label }. */
    delegations(id, after) {
      const calls = [];
      const rows = db.prepare("select position, agent_name, message_json from session_items where session_id = ? and item_type = 'message' and position > ? order by position").all(id, after);
      for (const row of rows) {
        let message;
        try { message = JSON.parse(row.message_json); } catch { continue; }
        for (const call of (message?.message ?? message)?.tool_calls || []) {
          const agentOf = DELEGATIONS[call?.function?.name];
          if (!agentOf || typeof call.id !== 'string') continue;
          let args = {};
          try { args = JSON.parse(call.function.arguments || '{}') || {}; } catch { /* no arguments */ }
          const agent = agentOf(args, row.agent_name || null);
          const label = call.function.name === 'run_skill' && typeof args.name === 'string' ? args.name : agent;
          calls.push({ callId: call.id, agent: typeof agent === 'string' ? agent : null, label: typeof label === 'string' ? label : null });
        }
      }
      return calls;
    },
    /** The id of the `offset`th newest top-level session (1 is the newest), as Docker Agent resolves `--session -N`. */
    relative(offset) {
      return db.prepare("select id from sessions where parent_id is null or parent_id = '' order by created_at desc limit 1 offset ?").get(offset - 1)?.id ?? null;
    },
    close() { db.close(); },
  };
}

export class DockerSessions {
  /**
   * @param {object} opts
   * @param {object} opts.session   the card's Session
   * @param {string} opts.launch    this launch's nonce, in the arguments of the hooks Agent Guild passed
   * @param {string} opts.store     the session.db the process uses
   * @param {(file: string) => Promise<object>} [opts.open]  opens the store (tests pass a fake)
   */
  constructor({ session, launch, store, open = openSessionStore }) {
    this.session = session;
    this.launch = launch;
    this.store = store;
    this.open = open;
    /** session id -> { role: 'main'|'sub'|'provisional', agentId, ended, watermark } */
    this.sessions = new Map();
    this.matched = new Set();
    this.unreadable = null;
    this._queue = Promise.resolve();
  }

  /** One hook event, as `dockerHookReport` shaped it. Events are handled in the order they arrive. */
  report(report) {
    const run = this._queue.then(() => this._handle(report));
    this._queue = run.catch(() => {});
    return run;
  }

  async _handle(report) {
    const sid = typeof report?.sessionId === 'string' && report.sessionId ? report.sessionId.slice(0, 200) : null;
    if (!sid || this.session.status !== 'running') return;
    const own = report.launch === this.launch;
    let entry = this.sessions.get(sid);
    if ((!entry || entry.role === 'provisional') && own) entry = await this._classify(sid, report, entry);
    else if (entry?.role === 'main' && own && report.event === 'SessionStart') await this._newRun(sid, entry);
    // An event without the nonce cannot say whose session it is; it only adds to a session already known.
    if (!entry) return;
    if (own) this.session.reportHello();
    this._apply(sid, entry, report);
  }

  async _classify(sid, report, entry) {
    let store;
    try {
      store = await this.open(this.store);
    } catch (err) {
      this._unreadable(err);
      return entry ?? this._remember(sid, { role: 'provisional' });
    }
    this._readable();
    try {
      const parent = store.parentOf(sid);
      if (parent === '') {
        const main = this._remember(sid, { role: 'main' });
        if (report.event === 'SessionStart') main.watermark = store.lastPosition(sid);
        return main;
      }
      if (parent !== undefined) return this._remember(sid, { role: 'sub', ended: true });
      const call = this._delegation(store, report.agentName);
      if (call) {
        this.matched.add(call.callId);
        const sub = this._remember(sid, { role: 'sub', agentId: `hook-${sid}`, name: call.label || report.agentName || 'subagent' });
        // Commands it ran while provisional were its own.
        if (entry) this.session.moveShells(sid, sub.agentId);
        this.session.reportAgent({ agentId: sub.agentId, name: sub.name, kind: 'subagent', status: 'working' }, 'api');
        return sub;
      }
      return entry ?? this._remember(sid, { role: 'provisional' });
    } catch (err) {
      this._unreadable(err);
      return entry ?? this._remember(sid, { role: 'provisional' });
    } finally {
      store.close();
    }
  }

  /** A main-level session's next run: only the delegation calls it saves from now on can be its sub-agents'. */
  async _newRun(sid, entry) {
    let store;
    try {
      store = await this.open(this.store);
    } catch (err) {
      this._unreadable(err);
      entry.watermark = undefined;
      return;
    }
    this._readable();
    try {
      entry.watermark = store.lastPosition(sid);
    } catch (err) {
      this._unreadable(err);
      entry.watermark = undefined;
    } finally {
      store.close();
    }
  }

  /** The oldest delegation call no sub-agent has claimed, saved during a main-level session's current run. */
  _delegation(store, agentName) {
    for (const [id, entry] of this.sessions) {
      if (entry.role !== 'main' || entry.watermark === undefined) continue;
      for (const call of store.delegations(id, entry.watermark)) {
        if (this.matched.has(call.callId)) continue;
        // From v1.81.2 a sub-agent's events name it; before, any unclaimed call is its own.
        if (agentName && call.agent && call.agent !== agentName) continue;
        return call;
      }
    }
    return null;
  }

  _remember(sid, entry) {
    this.sessions.delete(sid);
    this.sessions.set(sid, entry);
    if (this.sessions.size > MAX_SESSIONS) {
      for (const [id, old] of this.sessions) {
        if (old.role !== 'main' || id !== this.session.toolSessionId) { this.sessions.delete(id); break; }
      }
    }
    return entry;
  }

  _unreadable(err) {
    const reason = `Agent Guild cannot read Docker Agent's sessions (${err.message}), so this card does not follow a new session or show sub-agents.`;
    if (this.unreadable === reason) return;
    this.unreadable = reason;
    this.session.emit('warning', reason);
    this.session.setReportingNote(reason);
  }

  _readable() {
    if (this.unreadable === null) return;
    this.unreadable = null;
    this.session.setReportingNote(null);
  }

  _apply(sid, entry, report) {
    const { event } = report;
    const shellEvent = (event === 'PreToolUse' || event === 'PostToolUse') && report.toolName === SHELL_TOOL && report.toolUseId;
    if (entry.role === 'sub') {
      if (entry.ended) return;
      if (shellEvent) {
        if (event === 'PreToolUse') this.session.reportShell({ shell: 'start', key: report.toolUseId, match: report.match, agentId: entry.agentId, scope: sid });
        else this.session.reportShell({ shell: 'end', key: report.toolUseId });
      } else if (event === 'SessionEnd' || event === 'SubagentStop') {
        entry.ended = true;
        this.session.reportAgent({ agentId: entry.agentId, status: 'done' }, 'api');
      }
      return;
    }
    // Main-level and provisional sessions show their commands on the main agent, each turn ending only its own.
    if (shellEvent) {
      if (event === 'PreToolUse') this.session.reportShell({ shell: 'start', key: report.toolUseId, match: report.match, scope: sid });
      else this.session.reportShell({ shell: 'end', key: report.toolUseId });
    } else if (event === 'Stop') {
      this.session.finishForeground(sid);
    } else if (event === 'SessionEnd') {
      this.session.reportShell({ shell: 'reset', scope: sid });
      if (entry.role === 'provisional') this.sessions.delete(sid);
    }
    if (entry.role !== 'main') return;
    if (event === 'SessionStart' && report.launch === this.launch) this.session.reportToolSession({ toolSessionId: sid }, 'api');
    if (event === 'BeforeLlmCall' && report.model && sid === this.session.toolSessionId) this.session.reportModel({ model: report.model }, 'api');
  }
}
