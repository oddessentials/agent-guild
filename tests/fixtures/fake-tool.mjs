// A stand-in coding tool for tests. Works the same on every platform.
//   echo <text>        prints "ECHO:<text>"
//   agent <id> <name>  emits an in-band agent report (OSC 7777)
//   env                prints the Agent Guild variables
//   stubborn           ignores hang-up signals
//   exit <code>        exits with that code
import readline from 'node:readline';

process.stdout.write(`FAKE-TOOL READY cwd=${process.cwd()}\r\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd === 'echo') process.stdout.write(`ECHO:${rest.join(' ')}\r\n`);
  else if (cmd === 'agent') {
    const report = JSON.stringify({ agentId: rest[0], name: rest[1] || rest[0], status: rest[2] || 'working' });
    process.stdout.write(`\x1b]7777;agent-guild;${report}\x07`);
  } else if (cmd === 'env') {
    process.stdout.write(`ENV:${process.env.AGENT_GUILD_SESSION_ID}|${process.env.AGENT_GUILD_PROVIDER}|${process.env.AGENT_GUILD_URL}\r\n`);
  } else if (cmd === 'size') {
    process.stdout.write(`SIZE:${process.stdout.columns}x${process.stdout.rows}\r\n`);
  } else if (cmd === 'stubborn') {
    process.removeAllListeners('SIGHUP');
    process.on('SIGHUP', () => process.stdout.write('IGNORING-HUP\r\n'));
    process.stdout.write('STUBBORN\r\n');
  } else if (cmd === 'exit') process.exit(Number(rest[0] || 0));
});
process.on('SIGHUP', () => process.exit(129));
