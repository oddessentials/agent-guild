import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { commandHash, normalCommand, CLAUDE_BASH_MARK, CLAUDE_POWERSHELL_MARK } from '../report/hooks.mjs';

const SNAPSHOT_TIMEOUT_MS = 30000;

function run(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: SNAPSHOT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const why = err.killed ? `no answer within ${SNAPSHOT_TIMEOUT_MS / 1000} s` : `${err.code ?? err.signal}: ${String(stderr).trim().split('\n').pop() || err.message}`;
      reject(new Error(`${file} failed (${why})`));
    });
  });
}

function linuxProcess(pid) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  // The command name in parentheses may hold spaces and parentheses itself.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return {
    pid,
    ppid: Number(fields[1]),
    start: fields[19],
    args: () => {
      try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0$/, '').split('\0'); } catch { return []; }
    },
  };
}

function linuxChildren(pid) {
  let tasks;
  try { tasks = fs.readdirSync(`/proc/${pid}/task`); } catch { return []; }
  const out = [];
  for (const tid of tasks) {
    let text;
    try { text = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8'); } catch (err) { return err.code === 'ENOENT' ? null : []; }
    for (const child of text.trim().split(/\s+/)) if (child) out.push(Number(child));
  }
  return out;
}

function linuxSnapshot(roots) {
  const procs = new Map();
  if (roots) {
    const queue = [...roots];
    while (queue.length) {
      const pid = queue.shift();
      if (procs.has(pid)) continue;
      const proc = linuxProcess(pid);
      if (!proc) continue;
      procs.set(pid, proc);
      const children = linuxChildren(pid);
      if (children === null) return linuxSnapshot(null);
      queue.push(...children);
    }
    return procs;
  }
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const proc = linuxProcess(Number(name));
    if (proc) procs.set(proc.pid, proc);
  }
  return procs;
}

export function parsePs(output) {
  const procs = new Map();
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const command = m[4];
    procs.set(pid, { pid, ppid: Number(m[2]), start: m[3], args: () => [command] });
  }
  return procs;
}

export function splitWindowsCommandLine(line) {
  const args = [];
  const n = line.length;
  let i = 0;
  while (i < n) {
    while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    if (i >= n) break;
    let arg = '';
    let quoted = false;
    while (i < n) {
      const c = line[i];
      if (c === '\\') {
        let j = i;
        while (line[j] === '\\') j++;
        const slashes = j - i;
        if (line[j] === '"') {
          arg += '\\'.repeat(slashes >> 1);
          if (slashes & 1) {
            arg += '"';
            i = j + 1;
          } else {
            i = j;
          }
        } else {
          arg += '\\'.repeat(slashes);
          i = j;
        }
      } else if (c === '"') {
        if (quoted && line[i + 1] === '"') {
          arg += '"';
          i += 2;
        } else {
          quoted = !quoted;
          i++;
        }
      } else if (!quoted && (c === ' ' || c === '\t')) {
        break;
      } else {
        arg += c;
        i++;
      }
    }
    args.push(arg);
  }
  return args;
}

// Start times are strings: a FILETIME is beyond a double's precision.
export function parseWindowsProcesses(json) {
  const procs = new Map();
  let rows = JSON.parse(json.replace(/^\uFEFF/, '') || '[]');
  if (!Array.isArray(rows)) rows = [rows];
  for (const row of rows) {
    const pid = Number(row.p);
    const line = typeof row.c === 'string' ? row.c : '';
    procs.set(pid, { pid, ppid: Number(row.q), start: String(row.s), args: () => splitWindowsCommandLine(line) });
  }
  return procs;
}

const WINDOWS_QUERY = [
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8;',
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,CommandLine |',
  'ForEach-Object { [pscustomobject]@{ p = $_.ProcessId; q = $_.ParentProcessId; s = $(if ($_.CreationDate) { [string]$_.CreationDate.ToFileTimeUtc() } else { [string]0 }); c = $_.CommandLine } } |',
  'ConvertTo-Json -Compress',
].join(' ');

export async function snapshotProcesses(platform = process.platform, roots = null) {
  if (platform === 'linux') return linuxSnapshot(roots);
  if (platform === 'win32') return parseWindowsProcesses(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY]));
  return parsePs(await run('ps', ['-A', '-o', 'pid=,ppid=,lstart=,args='], { env: { ...process.env, LC_ALL: 'C' } }));
}

export function descendants(procs, rootPid) {
  const children = new Map();
  for (const p of procs.values()) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const out = [];
  let level = children.get(rootPid) || [];
  const seen = new Set([rootPid]);
  while (level.length) {
    const next = [];
    for (const p of level) {
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      out.push(p);
      next.push(...(children.get(p.pid) || []));
    }
    level = next;
  }
  return out;
}

function shellWord(text, i) {
  let word = '';
  while (i < text.length) {
    const c = text[i];
    if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) return null;
      word += text.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && '"\\$`'.includes(text[i + 1])) i++;
        word += text[i++];
      }
      if (i >= text.length) return null;
      i++;
    } else if (c === '\\') {
      word += text[i + 1] ?? '';
      i += 2;
    } else if (/\s/.test(c)) {
      break;
    } else {
      word += c;
      i++;
    }
  }
  return word;
}

// Claude Code's PowerShell tool runs `<prelude><command><suffix>`; compared after commandHash's normalisation, as ps shows
// a newline as "?".
const CLAUDE_PS_PRELUDE = normalCommand("try { $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8' } catch {}; if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage') { try { $OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}; if ($null -ne $PSStyle) { try { $PSStyle.OutputRendering = 'PlainText' } catch {} } };");
const CLAUDE_PS_SUFFIX = ' ; $_ec = if ($null -ne $LASTEXITCODE) {';

function claudePowerShellCommand(script) {
  const flat = normalCommand(script);
  const end = flat.indexOf(CLAUDE_PS_SUFFIX);
  if (end === -1) return null;
  const body = flat.slice(0, end);
  return body.startsWith(CLAUDE_PS_PRELUDE) ? body.slice(CLAUDE_PS_PRELUDE.length) : body;
}

export function commandCandidates(args) {
  // npm replaces its argv with a title, padded with empty arguments.
  const words = args.filter((arg, i) => i === 0 || arg !== '');
  const joined = words.join(' ');
  const hashes = new Set([commandHash(joined)]);
  for (const m of joined.matchAll(/(?:^|\s)(?:-l?c|-Command|\/[cC])\s/g)) {
    const rest = joined.slice(m.index + m[0].length);
    hashes.add(commandHash(rest));
    const ps = claudePowerShellCommand(rest);
    if (ps !== null) hashes.add(commandHash(ps));
  }
  for (const m of joined.matchAll(/(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/=]+)/g)) {
    const ps = claudePowerShellCommand(Buffer.from(m[1], 'base64').toString('utf16le'));
    if (ps !== null) hashes.add(commandHash(ps));
  }
  for (const m of joined.matchAll(/(?:^|[\s;&|(])eval\s+/g)) {
    const word = shellWord(joined, m.index + m[0].length);
    if (word) hashes.add(commandHash(word));
  }
  // A script started through its interpreter (`node /usr/bin/yarn run dev`), as given and by its file name.
  for (let i = 1; i < Math.min(words.length, 4); i++) {
    if (!/[\\/]/.test(words[i])) continue;
    const rest = words.slice(i + 1);
    hashes.add(commandHash([words[i], ...rest].join(' ')));
    hashes.add(commandHash([words[i].split(/[\\/]/).pop(), ...rest].join(' ')));
  }
  const npx = joined.match(/^npm exec (.+)$/);
  if (npx) hashes.add(commandHash(`npx ${npx[1]}`));
  if (/(?:^|\s)eval\s/.test(joined) && joined.includes(' && pwd -P >| ')) hashes.add(CLAUDE_BASH_MARK);
  if (joined.includes('$env:CLAUDE_CODE_SHELL_LAUNCHER_SCRIPT')) hashes.add(CLAUDE_POWERSHELL_MARK);
  return hashes;
}

export function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Whether the process bound to a command still runs: its start time on Linux, otherwise that the pid exists. */
export function processAlive(pid, start, platform = process.platform) {
  if (platform === 'linux') return linuxProcess(pid)?.start === start;
  return processExists(pid);
}
