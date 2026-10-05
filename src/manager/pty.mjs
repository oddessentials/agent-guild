// node-pty, the library that runs each session's terminal. Its Linux builds
// in the package need glibc 2.28 or later: on an older glibc they do not
// load, and on musl (Alpine) the x64 one loads, then crashes the manager when
// the first session starts. So the C library is checked before node-pty is
// loaded, unless node-pty was compiled on this computer, which it then loads
// in place of the builds it comes with.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** node-pty's folder. Looked up when needed, so commands that never run a terminal do not depend on it. */
export function ptyDir() {
  return path.dirname(require.resolve('node-pty/package.json'));
}

let glibc;

/** The glibc version this process runs on, such as '2.39'; null on another C library, such as musl. */
export function glibcVersion() {
  if (glibc !== undefined) return glibc;
  // Node.js reports it only on glibc, as npm reads it for a package's `libc`.
  // Leaving out network details keeps the report from looking up host names.
  const { report } = process;
  const excludeNetwork = report.excludeNetwork;
  report.excludeNetwork = true;
  try {
    glibc = report.getReport().header.glibcVersionRuntime ?? null;
  } finally {
    report.excludeNetwork = excludeNetwork;
  }
  return glibc;
}

/** True when node-pty's own builds run here: other systems than Linux, or glibc 2.28 or later. */
function bundledBuildsRun({ platform = process.platform, glibc: version } = {}) {
  if (platform !== 'linux') return true;
  if (version === undefined) version = glibcVersion();
  if (!version) return false;
  const [major, minor] = version.split('.').map(Number);
  return major > 2 || (major === 2 && minor >= 28);
}

/** Whether node-pty in `dir` was compiled on this computer; node-pty loads such a build before the ones it comes with. */
export function ptyBuiltHere(dir = ptyDir()) {
  return ['Release', 'Debug'].some((build) => fs.existsSync(path.join(dir, 'build', build, 'pty.node')));
}

const shellWord = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll('\'', '\'\\\'\'')}'`);

/** The command that compiles node-pty in `dir` for this computer. */
export function ptyBuildCommand(dir = ptyDir()) {
  return `cd ${shellWord(dir)} && npx --yes node-gyp rebuild`;
}

/**
 * On a computer that has to compile node-pty itself: the command that does,
 * and whether the files on disk hold such a build. Null where node-pty's own
 * builds run. `platform`, `glibc` and `dir` stand in for this computer's in tests.
 */
export function ptyBuild({ platform, glibc: version, dir } = {}) {
  if (bundledBuildsRun({ platform, glibc: version })) return null;
  dir ??= ptyDir();
  return { command: ptyBuildCommand(dir), built: ptyBuiltHere(dir) };
}

/**
 * Why node-pty cannot run here, as a message for the user, or null when it
 * can. Takes the same stand-ins as ptyBuild().
 */
export function ptyProblem(opts = {}) {
  const build = ptyBuild(opts);
  if (!build || build.built) return null;
  const version = opts.glibc === undefined ? glibcVersion() : opts.glibc;
  if (version) {
    return `Agent Guild needs glibc 2.28 or later on Linux, for example Debian 10, Ubuntu 20.04 or RHEL 8. This system has glibc ${version}.`;
  }
  return [
    'Agent Guild\'s terminal library, node-pty, comes built for Linux with glibc 2.28 or later, and this system uses another C library, such as musl on Alpine.',
    'To build it here, install Python 3, make, g++ and the Linux headers (on Alpine: apk add python3 make g++ linux-headers), then run this, and again after each Agent Guild upgrade:',
    `  ${build.command}`,
  ].join('\n');
}

let pty = null;

/** node-pty, loaded on first use. Throws with ptyProblem()'s message where it cannot run. */
export function loadPty() {
  if (pty) return pty;
  const problem = ptyProblem();
  if (problem) throw new Error(problem);
  pty = require('node-pty');
  return pty;
}
