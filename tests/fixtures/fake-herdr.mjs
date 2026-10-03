// Stands in for herdr. `herdr session list --json` names the socket in
// FAKE_HERDR_SOCKET as the running default session, where the test answers
// herdr's socket API itself; `herdr` alone is the client, which stays until
// it is stopped.

const args = process.argv.slice(2);
if (args[0] === 'session' && args[1] === 'list') {
  const session = { default: true, name: 'default', running: true, socket_path: process.env.FAKE_HERDR_SOCKET };
  process.stdout.write(`${JSON.stringify({ sessions: [session] })}\n`);
} else {
  process.stdout.write('FAKE-HERDR READY\r\n');
  setInterval(() => {}, 1 << 30);
}
