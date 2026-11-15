// `hermes -p <profile> ...` for the commands Agent Guild's reporting setup runs, answered as Hermes Agent 0.23.1 answers them.
// The profile's home follows $HERMES_HOME as `hermes -p` does. Calls are logged to $FAKE_HERMES_LOG, one argv per line.
// $FAKE_HERMES_FAIL names a command, as in "plugins disable", that exits 1 with no output, for the profile
// $FAKE_HERMES_FAIL_PROFILE only when that is set; $FAKE_HERMES_HANG names one
// that writes its process id to $FAKE_HERMES_PID and never ends. Each call's profile and the home it resolves are logged to
// $FAKE_HERMES_HOMES, one JSON object per line. `config get` answers as for a key that is not set. `plugins install` keeps
// the plugin's source as Hermes's install record names it, `git pinned@<sha8>` with --ref, and refuses an installed plugin
// without --force; enable and disable keep that source. $FAKE_HERMES_UNPINNED makes install ignore --ref.

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (process.env.FAKE_HERMES_LOG) fs.appendFileSync(process.env.FAKE_HERMES_LOG, `${JSON.stringify(argv)}\n`);
const [profile, rest] = argv[0] === '-p' ? [argv[1], argv.slice(2)] : ['default', argv];
const set = path.resolve(process.env.HERMES_HOME);
const root = path.basename(path.dirname(set)) === 'profiles' ? path.dirname(path.dirname(set)) : set;
const home = profile === 'default' ? root : path.join(root, 'profiles', profile);
const stateFile = path.join(home, 'fake-plugins.json');
const command = rest.slice(0, 2).join(' ');
if (process.env.FAKE_HERMES_HOMES) fs.appendFileSync(process.env.FAKE_HERMES_HOMES, `${JSON.stringify({ profile, home, command })}\n`);
const installed = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8'))[0] ?? null; } catch { return null; } };
const plugin = (status, source = installed()?.source ?? null) => fs.writeFileSync(stateFile, JSON.stringify([{ name: 'agent-guild', status, source }]));

if (process.env.FAKE_HERMES_FAIL === command && (process.env.FAKE_HERMES_FAIL_PROFILE ?? profile) === profile) process.exit(1);
if (process.env.FAKE_HERMES_HANG === command) {
  fs.writeFileSync(process.env.FAKE_HERMES_PID, String(process.pid));
  await new Promise(() => setInterval(() => {}, 1000));
}
if (command === 'config env-path') {
  process.stdout.write(`${path.join(home, '.env')}\n`);
} else if (command === 'config get') {
  process.stdout.write(`Config key not set: ${rest[2]}\n`);
  process.exit(1);
} else if (command === 'plugins list') {
  let list = '[]';
  try { list = fs.readFileSync(stateFile, 'utf8'); } catch { /* none installed */ }
  process.stdout.write(`${list}\n`);
} else if (command === 'plugins install') {
  if (installed() && !rest.includes('--force')) {
    process.stderr.write("Error: Plugin 'agent-guild' is already installed. Use --force to reinstall it.\n");
    process.exit(1);
  }
  const ref = rest.includes('--ref') && !process.env.FAKE_HERMES_UNPINNED ? rest[rest.indexOf('--ref') + 1] : null;
  plugin('enabled', ref ? `git pinned@${ref.slice(0, 8)}` : rest[2]);
} else if (command === 'plugins enable') {
  plugin('enabled');
} else if (command === 'plugins disable') {
  plugin('disabled');
} else if (command !== 'config set' && command !== 'config unset') {
  process.stderr.write(`hermes: unexpected arguments: ${argv.join(' ')}\n`);
  process.exit(2);
}
