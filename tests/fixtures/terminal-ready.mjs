import { stripVTControlCharacters } from 'node:util';

/** Observe the fixture starting, including output already present in the snapshot.
 * The deadline is only a hang guard; elapsed time never establishes readiness. */
export function waitForTerminalReady(socket, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    let output = '';
    const finish = (error) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
      if (error) reject(new Error(`${error}\nTerminal output: ${JSON.stringify(output.slice(-2000))}`));
      else resolve();
    };
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); }
      catch (error) { finish(`Invalid terminal message: ${error.message}`); return; }
      if (message.type === 'snapshot') {
        output = message.data;
        if (message.session.status !== 'running') {
          finish(`Session exited before readiness: exitCode=${message.session.exitCode}, signal=${message.session.signal}`);
          return;
        }
      } else if (message.type === 'data') output += message.data;
      else if (message.type === 'exit') {
        finish(`Session exited before readiness: exitCode=${message.exitCode}, signal=${message.signal}`);
        return;
      }
      if (stripVTControlCharacters(output).includes('FAKE-TOOL READY')) finish();
    };
    const onError = (error) => finish(`Terminal socket error: ${error.message}`);
    const onClose = (code) => finish(`Terminal socket closed before readiness: code=${code}`);
    const timer = setTimeout(() => finish('Timed out waiting for FAKE-TOOL READY'), timeoutMs);
    socket.on('message', onMessage);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}
