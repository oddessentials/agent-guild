// Pure helpers for the phone view. No DOM, so `npm test` covers them in Node.

/** A session at a glance, in the order the list shows them: what may be waiting for you first. */
export const STATES = ['attention', 'active', 'busy', 'task', 'detached', 'exited'];

const LABELS = { attention: 'Quiet', active: 'Active', busy: 'Busy', task: 'Running', detached: 'Detached', exited: 'Exited' };

/**
 * How a session reads from a phone. A running tool that is quiet with no
 * agents and no commands is probably waiting for you, so it comes first;
 * the manager has no explicit "waiting for input" signal, so this is a
 * reading of activity, not a report.
 */
export function sessionState(session) {
  if (session.status !== 'running') return session.multiplexer?.reattachable ? 'detached' : 'exited';
  if (session.task) return 'task';
  if (session.activity === 'active') return 'active';
  if ((session.agents?.length || 0) > 0 || (session.shells?.length || 0) > 0) return 'busy';
  return 'attention';
}

export function stateLabel(session) {
  const state = sessionState(session);
  if (state === 'exited' && !session.multiplexer && session.exitCode !== null && session.exitCode !== undefined && session.exitCode !== 0) {
    return `Exited (${session.exitCode})`;
  }
  return LABELS[state];
}

/** What the session is doing in a few words: agents, commands and the model while running; how it ended otherwise. */
export function sessionSummary(session) {
  if (session.status !== 'running') {
    if (session.multiplexer) return session.multiplexer.reattachable ? `${session.multiplexer.label} still runs this session` : `${session.multiplexer.label} session ended`;
    if (session.signal) return `Ended by ${session.signal}`;
    return session.exitCode ? `Exited with code ${session.exitCode}` : 'Exited';
  }
  const parts = [];
  const agents = session.agents?.length || 0;
  const shells = session.shells?.length || 0;
  if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`);
  if (shells) parts.push(`${shells} command${shells === 1 ? '' : 's'}`);
  const model = session.model?.displayName || session.model?.name;
  if (model) parts.push(model);
  return parts.join(' · ');
}

/** Sessions that may need you first, then the rest, newest first; a fixed order for the same input. */
export function orderSessions(sessions) {
  const rank = (session) => STATES.indexOf(sessionState(session));
  return [...sessions].sort((a, b) => rank(a) - rank(b)
    || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))
    || String(a.id).localeCompare(String(b.id)));
}

/** The last part of a folder path on either platform, or the whole path when it has no parts. */
export function folderName(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  const trimmed = cwd.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed || cwd;
}

/** "now", "42s", "5m", "3h" or "2d" since an ISO time; '' without one. */
export function relativeTime(iso, now = Date.now()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return 'now';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** The token in what was typed or pasted: the token itself, or a sign-in link carrying it. Null otherwise. */
export function tokenFromInput(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  let url = null;
  try { url = new URL(value); } catch { /* not a link */ }
  if (url) {
    const token = new URLSearchParams(url.hash.slice(1)).get('token');
    return token && token.trim() ? token.trim() : null;
  }
  return /^[^\s#?&/]+$/.test(value) ? value : null;
}

/** The token in a page's location hash, or null. */
export function tokenFromHash(hash) {
  const token = new URLSearchParams(String(hash ?? '').replace(/^#/, '')).get('token');
  return token && token.trim() ? token.trim() : null;
}

/** Dictated words as terminal input: one line of text, no control characters, so nothing is ever submitted. */
export function dictatedText(text, first) {
  const clean = String(text ?? '').replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? (first ? clean : ` ${clean}`) : '';
}

/** The text sizes the terminal offers, and the next one up or down from the current. */
export const FONT_SIZES = [11, 12, 13, 14, 16, 18];
export const DEFAULT_FONT_SIZE = 13;

export function stepFontSize(current, direction) {
  const at = FONT_SIZES.includes(current) ? FONT_SIZES.indexOf(current) : FONT_SIZES.indexOf(DEFAULT_FONT_SIZE);
  return FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, at + Math.sign(direction)))];
}

/**
 * How long a request may go unanswered before the phone reports it, so no button waits on a dead network. Starting or
 * reattaching a session gets longer: a tool's first session answers after its hook probe (PROBE_TIMEOUT_MS in
 * session-hooks.mjs, which Codex may run twice), and a tmux or herdr session after the multiplexer answers
 * (RUN_TIMEOUT_MS in command-resolver.mjs). The manager finishes a start whether or not the phone is still waiting,
 * so a budget below those would report a session that then appears, and starting again would make a second one.
 * tests/mobile.test.mjs keeps the two budgets apart.
 */
export const REQUEST_TIMEOUT_MS = 15000;
export const START_TIMEOUT_MS = 60000;

/** The line a terminal shows when its process ends. A tmux or herdr client's exit code says nothing about the session it showed. */
export function exitLine(session, { exitCode, signal }) {
  if (session?.multiplexer) return '[closed]';
  return `[process exited with ${signal ? `signal ${signal}` : `code ${exitCode ?? 0}`}]`;
}
