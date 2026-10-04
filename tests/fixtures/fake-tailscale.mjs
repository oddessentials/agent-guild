import fs from 'node:fs';

const file = process.env.FAKE_TAILSCALE_STATE;
if (!file) throw new Error('FAKE_TAILSCALE_STATE is required');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (state.log) fs.appendFileSync(state.log, JSON.stringify({ args, cli: process.env.TAILSCALE_BE_CLI }) + '\n');
if (state.behavior === 'hang') await new Promise(() => { setInterval(() => {}, 1000); });
if (state.behavior === 'malformed' && args[0] === 'status') {
  console.log('invalid json');
} else if (args[0] === 'version') {
  console.log(state.version || '1.102.2');
} else if (args[0] === 'status') {
  console.log(JSON.stringify({ BackendState: state.backend || 'Running', Self: { ID: 'test-node', DNSName: 'guild.example.ts.net.' }, CertDomains: state.https === false ? [] : ['guild.example.ts.net'] }));
} else if (args[0] === 'serve' && args[1] === 'status') {
  console.log(JSON.stringify(state.config || {}));
} else if (args[0] === 'serve') {
  if (state.behavior === 'permission') {
    console.error('serve config denied');
    process.exitCode = 1;
  } else if (state.behavior === 'approval') {
    console.log('Enable HTTPS: https://login.tailscale.com/f/serve-test');
  } else {
    const port = args.find((arg) => arg.startsWith('--https=')).split('=')[1];
    const authority = `guild.example.ts.net:${port}`;
    state.config ||= {};
    state.config.TCP ||= {};
    state.config.Web ||= {};
    if (args.at(-1) === 'off') {
      delete state.config.Web[authority];
      delete state.config.TCP[port];
    } else {
      state.config.TCP[port] = { HTTPS: true };
      state.config.Web[authority] = { Handlers: { '/': { Proxy: args.at(-1) } } };
    }
    fs.writeFileSync(file, JSON.stringify(state));
    console.log('Done');
  }
} else {
  throw new Error('Unexpected fake Tailscale command');
}
