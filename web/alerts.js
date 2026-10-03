// When the page plays an alert sound: a session has finished its work and
// sits idle, the session manager stops, or a new Agent Guild version is out.
// Sounds are off until the user turns them on.

export const SOUNDS = {
  idle: 'sounds/session-idle.wav',
  stopped: 'sounds/manager-stopped.wav',
  update: 'sounds/update-available.wav',
};

/** How long a session must have produced output, after the last key typed into it here, for its going quiet to count. */
export const MIN_WORK_MS = 8000;
/** How long it must then stay idle, so a pause between two steps does not sound. */
export const SETTLE_MS = 1500;

/** How long the page that played an alert keeps other open pages from playing the same one. */
export const SHARED_MS = 5000;

/**
 * Every open page watches the same sessions, so each alert takes a lock named
 * after it: the page that gets it plays and holds it a while, and the others
 * skip. Without Web Locks every page plays.
 */
export function playOnce(key, play, { locks = globalThis.navigator?.locks, holdMs = SHARED_MS, wait = setTimeout } = {}) {
  if (!locks) return play();
  locks.request(`agentGuild.sound.${key}`, { ifAvailable: true }, (lock) => {
    if (!lock) return null;
    play();
    return new Promise((resolve) => wait(resolve, holdMs));
  }).catch(() => {});
}

/** A running session with a quiet terminal, no working agent and no shell command. */
export function sessionIdle(s) {
  return s.status === 'running' && s.activity !== 'active'
    && !(s.agents || []).some((a) => a.status === 'working') && !(s.shells || []).length;
}

/**
 * Calls `chime(id)` once each time a session finishes a stretch of work and
 * settles idle. Output that only echoes what was typed here does not count,
 * and typing into a session cancels its pending alert.
 */
export function idleWatcher({ chime, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, minWorkMs = MIN_WORK_MS, settleMs = SETTLE_MS }) {
  const watched = new Map();
  const cancel = (w) => {
    clearTimer(w.timer);
    w.timer = null;
  };
  const entry = (id) => {
    if (!watched.has(id)) watched.set(id, { activeSince: null, lastInput: 0, armed: false, timer: null });
    return watched.get(id);
  };
  const forget = (id) => {
    const w = watched.get(id);
    if (w) cancel(w);
    watched.delete(id);
  };

  function update(s) {
    if (s.status !== 'running') return forget(s.id);
    const w = entry(s.id);
    if (s.activity === 'active') {
      w.activeSince ??= now();
      return cancel(w);
    }
    if (w.activeSince !== null) {
      if (now() - Math.max(w.activeSince, w.lastInput) >= minWorkMs) w.armed = true;
      w.activeSince = null;
    }
    if (!w.armed || !sessionIdle(s)) return cancel(w);
    if (w.timer) return;
    w.timer = setTimer(() => {
      w.timer = null;
      w.armed = false;
      chime(s.id);
    }, settleMs);
  }

  function input(id) {
    const w = entry(id);
    w.lastInput = now();
    w.armed = false;
    cancel(w);
  }

  function clear() {
    for (const id of [...watched.keys()]) forget(id);
  }

  return { update, input, forget, clear };
}

/** True once per connection to the manager: when it stops, restarts or goes away. */
export function stopWatcher() {
  let connected = false;
  return {
    connected() { connected = true; },
    stopped() {
      const was = connected;
      connected = false;
      return was;
    },
  };
}

/** True when the manager reports a newer version than any this page has seen. The first report sets the baseline. */
export function updateWatcher() {
  let seen;
  return (upgrade) => {
    const version = upgrade?.available ? upgrade.latestVersion || null : null;
    const first = seen === undefined;
    if (first) seen = null;
    if (!version || version === seen) return false;
    seen = version;
    return !first;
  };
}
