// Sounds follow manager availability and new releases, never session activity.
export const SOUNDS = {
  stopped: 'sounds/manager-stopped.wav',
  update: 'sounds/update-available.wav',
};

export const MAX_ALERT_AGE_MS = 10000;
export const RECOVERY_WAIT_MS = 2000;
export const HEALTH_TIMEOUT_MS = 1000;
const PLAYED_KEY = 'agentGuild.playedSounds';

/** Queue eligible pages, allowing another page to try if playback fails.
 * Record only successful playback, under the same cross-tab lock. A bounded
 * ledger prevents delayed tabs from replaying the event after lock release.
 * Without shared coordination, stay silent rather than multiply alerts.
 */
export async function playOnce(key, play, { locks = globalThis.navigator?.locks, storage, fresh = () => true, related = [] } = {}) {
  if (!locks) return false;
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return false;
    return await locks.request('agentGuild.sound', async () => {
      if (!fresh()) return false;
      let played = JSON.parse(storage.getItem(PLAYED_KEY) || '[]');
      if (!Array.isArray(played)) played = [];
      if (played.includes(key) || related.some((other) => played.includes(other))) return false;
      // Check storage is writable before making a sound.
      storage.setItem(PLAYED_KEY, JSON.stringify(played.slice(-127)));
      try {
        if (await play() === false) return false;
      } catch { return false; }
      storage.setItem(PLAYED_KEY, JSON.stringify([...played.slice(-127), key]));
      return true;
    });
  } catch { return false; }
}

/** A live connection rearms an availability alert for a later outage. */
export async function rearmSound(key, { locks = globalThis.navigator?.locks, storage } = {}) {
  if (!locks) return;
  try {
    storage ??= globalThis.localStorage;
    if (!storage) return;
    await locks.request('agentGuild.sound', () => {
      const played = JSON.parse(storage.getItem(PLAYED_KEY) || '[]');
      if (Array.isArray(played) && played.includes(key)) {
        storage.setItem(PLAYED_KEY, JSON.stringify(played.filter((item) => item !== key)));
      }
    });
  } catch { /* Optional sound coordination may be unavailable. */ }
}

/** Two bounded health checks, only after losing a previously live connection.
 * Reconnect, shutdown and page departure cancel both requests and timers.
 * The callback's freshness check also cancels playback waiting on another tab.
 */
export function managerLossWatcher({ reachable, unavailable, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let live = false;
  let pending = null;
  const cancel = () => {
    pending?.abort();
    pending = null;
    live = false;
  };
  const check = async (signal) => {
    const request = new AbortController();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimer(abort, HEALTH_TIMEOUT_MS);
    try { return await reachable(request.signal); }
    catch { return false; }
    finally {
      clearTimer(timer);
      signal.removeEventListener('abort', abort);
    }
  };
  const wait = (signal) => new Promise((resolve) => {
    const done = () => {
      clearTimer(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimer(done, RECOVERY_WAIT_MS);
    signal.addEventListener('abort', done, { once: true });
  });
  return {
    connected() { cancel(); live = true; },
    cancel,
    async disconnected() {
      if (!live) return;
      live = false;
      const controller = new AbortController();
      pending = controller;
      const at = now();
      const fresh = () => pending === controller && !controller.signal.aborted && now() - at <= MAX_ALERT_AGE_MS;
      if (await check(controller.signal) || !fresh()) return;
      await wait(controller.signal);
      if (!fresh() || await check(controller.signal) || !fresh()) return;
      unavailable(at, fresh);
    },
  };
}

/** Reconnecting establishes a baseline; only a live stop event alerts. */
export function stopWatcher() {
  let instance = null;
  let stopped = false;
  return {
    connected(next) {
      if (next !== instance) stopped = false;
      instance = next;
    },
    stopped() {
      if (!instance || stopped) return null;
      stopped = true;
      return instance;
    },
  };
}

// Published releases use semantic versions, including numerically ordered
// prerelease identifiers. Build metadata does not affect precedence.
function versionParts(value) {
  return typeof value === 'string' ? value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/) : null;
}
function newer(a, b) {
  const av = versionParts(a), bv = versionParts(b);
  for (let i = 1; i <= 3; i++) if (+av[i] !== +bv[i]) return +av[i] > +bv[i];
  if (!av[4] || !bv[4]) return Boolean(bv[4]) && !av[4];
  const ap = av[4].split('.'), bp = bv[4].split('.');
  for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
    if (ap[i] === bp[i]) continue;
    if (ap[i] === undefined || bp[i] === undefined) return bp[i] === undefined;
    const an = /^\d+$/.test(ap[i]), bn = /^\d+$/.test(bp[i]);
    if (an && bn) return +ap[i] > +bp[i];
    if (an !== bn) return bn;
    return ap[i] > bp[i];
  }
  return false;
}

/** The first successful version report is a baseline, even after nulls.
 * Reconnect snapshots also advance it silently. Never alert on a rollback.
 */
export function updateWatcher() {
  let seen = null;
  return (upgrade, baseline = false) => {
    const version = upgrade?.latestVersion;
    if (!versionParts(version)) return false;
    if (!seen) { seen = version; return false; }
    if (!newer(version, seen)) return false;
    seen = version;
    return !baseline && upgrade.available === true;
  };
}
