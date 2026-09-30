// A stand-in coding tool for tests. Works the same on every platform.
//   echo <text>        prints "ECHO:<text>"
//   agent <id> <name>  emits an in-band agent report (OSC 7777)
//   args               prints the arguments that followed the script path
//   env                prints the Agent Guild variables
//   size               prints the terminal size
//   query [cpr|bg]     asks the terminal for the cursor position or the
//                      background colour, then prints every reply received
//                      within 1.5 s
//   modes              hides the cursor and enables SGR mouse reporting
//   stubborn           ignores hang-up signals
//   exit <code>        exits with that code

const out = (text) => process.stdout.write(`${text}\r\n`);
out(`FAKE-TOOL READY cwd=${process.cwd()}`);

let buffer = '';
let collecting = null;

function handle(line) {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  if (cmd === 'echo') out(`ECHO:${rest.join(' ')}`);
  else if (cmd === 'agent') {
    const report = JSON.stringify({ agentId: rest[0], name: rest[1] || rest[0], status: rest[2] || 'working' });
    process.stdout.write(`\x1b]7777;agent-guild;${report}\x07`);
  } else if (cmd === 'args') out(`ARGS:${JSON.stringify(process.argv.slice(2))}`);
  else if (cmd === 'env') {
    out(`ENV:${process.env.AGENT_GUILD_SESSION_ID}|${process.env.AGENT_GUILD_PROVIDER}|${process.env.AGENT_GUILD_URL}`);
  } else if (cmd === 'size') {
    // getWindowSize() asks the console directly; .columns can be stale on Windows.
    const [cols, rows] = process.stdout.getWindowSize ? process.stdout.getWindowSize() : [process.stdout.columns, process.stdout.rows];
    out(`SIZE:${cols}x${rows}`);
  } else if (cmd === 'query') {
    const kind = rest[0] || 'cpr';
    const request = kind === 'bg' ? '\x1b]11;?\x07' : '\x1b[6n';
    const pattern = kind === 'bg' ? /\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/g : /\x1b\[\d+;\d+R/g;
    // Raw mode, as real TUIs use, so the reply arrives without a newline.
    process.stdin.setRawMode?.(true);
    collecting = '';
    process.stdout.write(request);
    setTimeout(() => {
      const replies = collecting.match(pattern) || [];
      collecting = null;
      process.stdin.setRawMode?.(false);
      out(`REPLIES:${replies.length}:${JSON.stringify(replies)}`);
    }, 1500);
  } else if (cmd === 'modes') {
    process.stdout.write('\x1b[?25l\x1b[?1000h\x1b[?1006h');
    out('MODES-SET');
  } else if (cmd === 'stubborn') {
    process.removeAllListeners('SIGHUP');
    process.on('SIGHUP', () => out('IGNORING-HUP'));
    out('STUBBORN');
  } else if (cmd === 'exit') process.exit(Number(rest[0] || 0));
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (collecting !== null) {
    collecting += chunk;
    return;
  }
  buffer += chunk;
  let index;
  while ((index = buffer.search(/[\r\n]/)) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) handle(line);
  }
});
process.on('SIGHUP', () => process.exit(129));
