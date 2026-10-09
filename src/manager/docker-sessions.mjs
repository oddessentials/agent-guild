// Which Docker Agent session each of its hook events belongs to.
//
// One `docker agent run` process runs several sessions: the one in each TUI tab (/new, /fork and /sessions
// open more), and one per sub-agent (transfer_task, run_background_agent, run_skill). Every hook event
// carries its session_id, and from 1.81.2 the name of the agent that runs the session. The card decides
// from these and from two facts about Docker Agent (read in its source, v1.55.0 to v1.149.0):
// - session_start runs at the top of every run of a session, and the run waits for the hook command to
//   finish. A sub-agent's session runs inside a run of its parent, so the first event under a launch
//   always comes from a top-level session, and a sub-agent's first event after its parent's session_start.
// - A sub-agent's session carries its agent's name; a skill's carries its caller's. A tab is a runtime of its
//   own that starts with the agent the process was launched with (cmd/root/run.go), whatever agent the user
//   switched to elsewhere.
//
// So the main session is the first session heard from: the one Agent Guild named or resumed, unless the user
// opened a tab before the first prompt. Resume targets it from then on and never moves. Another session is a
// sub-agent when the agent name on its first event differs from the launch agent (the first event's) and that
// event comes inside a run of a session already heard from (between its session_start and its session_end; a
// stop is not the run's end, since a queued follow-up or a forced handoff continues the run after it with no new
// session_start), since a sub-agent only ever runs inside its parent's run; decided then and kept. Anything else
// (a tab, a skill run by the launch agent, a version with no agent names, a session first heard from while
// nothing runs) is main-level: its commands show on the card's main agent, its turn ends end only its own
// commands, and it gets no agent card. A background agent is shown while its session runs. Known omissions: a
// sub-agent that has the launch agent's name shows no card; the launch agent is the one named on the first event,
// so an agent switched to before the first prompt counts as it; a tab prompted under another agent's name while
// a tab's run is in progress shows as a sub-agent; commands Docker Agent allows without asking fire no pre_tool_use, so
// they never show (examples/docker-agent-hooks.yaml adds that).

import { commandHash, normalizeEventName } from '../report/hooks.mjs';

const SHELL_TOOL = 'shell';
const MAX_SESSIONS = 512;
const MAX_ID = 200;

const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

export class DockerSessions {
  /**
   * @param {object} session  the card's Session
   * @param {{ mainId?: string|null }} [opts]  the Docker Agent session Agent Guild named or resumed, when it did
   */
  constructor(session, { mainId = null } = {}) {
    this.session = session;
    this.mainId = mainId;
    this.heard = false;
    this.launchAgent = null;
    /** other sessions heard from, by id: { sub: boolean } */
    this.sessions = new Map();
    /** ids of sessions in a run: from their session_start to their session_end */
    this.open = new Set();
  }

  /** One hook event, as `dockerHookEvent` (src/report/hooks.mjs) shaped it. Throws 400 for a malformed one, 409 once the session has exited. */
  report(event) {
    if (!event || typeof event !== 'object') throw badRequest('a Docker Agent event must be an object');
    const sid = text(event.sessionId);
    if (!sid || sid.length > MAX_ID || /\p{Cc}/u.test(sid)) throw badRequest(`sessionId must be a printable id of at most ${MAX_ID} characters`);
    const name = normalizeEventName(text(event.event));
    if (!name) throw badRequest('event is required');
    const session = this.session;
    // Any event means the hooks are in place; this also refuses events after the session's exit.
    session.reportHello();
    // The first session heard from is the one the user works in: the session named at launch, unless the user
    // opened a tab (/new) before the first prompt, in which case the named one stays empty and Resume follows the tab.
    if (!this.heard) {
      this.heard = true;
      if (this.mainId !== sid) {
        this.mainId = sid;
        session.reportToolSession({ toolSessionId: sid });
      }
    }
    const agentName = text(event.agentName)?.slice(0, 80) ?? null;
    // The agent the process was launched with: every tab starts with it, whatever agent another tab switched to.
    if (this.launchAgent === null && agentName) this.launchAgent = agentName;
    // A run begins with session_start and ends with session_end, not with a stop, which a follow-up or a forced
    // handoff continues from; a sub-agent can only begin inside one.
    const inRun = this.open.size > 0;
    if (name === 'SessionStart') this._open(sid);
    else if (name === 'SessionEnd') this.open.delete(sid);
    if (sid === this.mainId) {
      this._shell(event, name, sid, null);
      if (name === 'Stop' || name === 'SessionEnd') session.reportAgent({ finishForeground: true });
      const model = text(event.model);
      if (model && (name === 'BeforeLlmCall' || name === 'AfterLlmCall')) session.reportModel({ model });
      return;
    }
    const agentId = `hook-${sid}`;
    const ending = name === 'SessionEnd' || name === 'SubagentStop';
    let entry = this.sessions.get(sid);
    if (!entry) {
      // A session first heard of at its end has nothing to show.
      if (ending) return;
      entry = { sub: Boolean(agentName) && agentName !== this.launchAgent && inRun };
      this._remember(sid, entry);
      // The card holds 64 agents; past that the sub-agent's commands still show and end with it.
      if (entry.sub) try { session.reportAgent({ agentId, name: agentName, kind: 'subagent', status: 'working' }); } catch { /* full */ }
    }
    this._shell(event, name, sid, agentId);
    // A done report for an agent that was never shown only ends its commands, which is all a tab needs.
    if (ending || (!entry.sub && name === 'Stop')) session.reportAgent({ agentId, status: 'done' });
    // A sub-agent's session runs once; a tab's runs again at its next prompt, with the role it was given.
    if (name === 'SessionEnd' && entry.sub) this.sessions.delete(sid);
  }

  _shell(event, name, sid, agentId) {
    if (text(event.toolName) !== SHELL_TOOL) return;
    const agent = agentId ? { agentId } : {};
    const match = typeof event.command === 'string' ? { match: commandHash(event.command) } : {};
    if (name === 'PermissionRequest') return this.session.reportShell({ shell: 'waiting', ...agent, ...match });
    const id = text(event.toolUseId);
    if (!id) return;
    // Call ids repeat across sessions when a model answers with XML tool calls (call_0, call_1).
    const full = `${sid}/${id}`;
    const key = full.length > 128 ? commandHash(full) : full;
    if (name === 'PreToolUse') this.session.reportShell({ shell: 'start', key, ...agent, ...match });
    else if (name === 'PostToolUse') this.session.reportShell({ shell: 'end', key });
  }

  _remember(sid, entry) {
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value);
    this.sessions.set(sid, entry);
  }

  _open(sid) {
    // A run whose end was never heard (a session Docker Agent dropped) is forgotten before the oldest ones pile up.
    if (this.open.size >= MAX_SESSIONS) this.open.delete(this.open.keys().next().value);
    this.open.add(sid);
  }
}
