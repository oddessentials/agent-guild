// systemctl and journalctl over an in-memory user manager, for tests that
// must never reach a real one. Pass `run` as a runner; `state` changes what
// it reports, `calls` records each command, and `onCall` sees each one first.

import { SHOW_PROPERTIES } from '../../src/manager/systemd-service.mjs';

export function fakeSystemd({ reachable = true, missing = false, show = {}, onCall = () => {} } = {}) {
  const state = {
    reachable,
    missing,
    enabled: false,
    show: { LoadState: 'not-found', UnitFileState: '', ActiveState: 'inactive', Result: 'success', ExecMainStatus: '0', MainPID: '0', ExecMainStartTimestamp: '', InactiveEnterTimestamp: '', ...show },
    fail: new Set(),
    journal: 'line one\nline two\n',
  };
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    await onCall(command, args);
    if (state.missing) return { status: 127, stdout: '', stderr: `spawn ${command} ENOENT`, missing: true };
    if (!state.reachable) return { status: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found' };
    if (command === 'journalctl') return { status: 0, stdout: state.journal, stderr: '' };
    const verb = args[1] === '--no-block' ? args[2] : args[1];
    if (state.fail.has(verb)) return { status: 1, stdout: '', stderr: `${verb} refused` };
    if (verb === 'show') {
      const shown = { ...state.show, UnitFileState: state.enabled ? 'enabled' : state.show.UnitFileState };
      return { status: 0, stdout: `${SHOW_PROPERTIES.map((p) => `${p}=${shown[p] ?? ''}`).join('\n')}\n`, stderr: '' };
    }
    if (verb === 'enable') state.enabled = true;
    if (verb === 'disable') state.enabled = false;
    return { status: 0, stdout: '', stderr: '' };
  };
  /** The systemctl verbs called, in order. */
  const verbs = () => calls.filter(([command]) => command === 'systemctl').map(([, , verb, next]) => (verb === 'start' && next === '--no-block' ? 'start --no-block' : verb));
  return { state, calls, run, verbs };
}
