/**
 * A mocked pty as Session uses it, with the parts of node-pty's Windows terminal that closeConsole() and releasePty()
 * reach, so a mock works on every host. Closing its console calls its own kill(), as the process ending would.
 */
export function fakePty(term = {}) {
  for (const [name, value] of Object.entries({ pid: 0, onData() {}, onExit() {}, write() {}, resize() {}, kill() {} })) {
    if (!(name in term)) term[name] = value;
  }
  term._deferNoArgs = (fn) => fn();
  term._close = () => {};
  term._agent = {
    _pty: 0, _pendingPtyInfo: undefined, _clearConnectionTimeout() {}, _inSocket: { destroy() {} }, _outSocket: {},
    _ptyNative: { kill: () => term.kill() }, _conoutSocketWorker: { dispose() {} },
  };
  return term;
}
