#!/usr/bin/env node
// Report an agent, or the model in use, inside an Agent Guild session.
//
// The session manager injects AGENT_GUILD_URL, AGENT_GUILD_SESSION_ID and
// AGENT_GUILD_REPORT_TOKEN into every terminal it starts. Outside such a
// terminal this command does nothing and exits 0, so hooks that call it are
// harmless when the tool runs elsewhere.
//
//   agent-guild-report <agent-id> [--name N] [--status working|waiting|idle|done]
//                      [--detail TEXT] [--kind KIND] [--remove]
//   agent-guild-report --model NAME [--display-name TEXT]
//   agent-guild-report --hook                (reads a hook event as JSON on stdin:
//                                             Claude Code, Codex CLI, Gemini CLI, Grok Build)
//   agent-guild-report --claude-statusline [--passthrough]
//                      (reads Claude Code status line JSON on stdin; prints a
//                       status line, or the JSON itself with --passthrough)

import { hookToReports, claudeStatuslineToReport, formatStatusLine } from '../src/report/hooks.mjs';

const env = process.env;
const inSession = env.AGENT_GUILD_URL && env.AGENT_GUILD_SESSION_ID && env.AGENT_GUILD_REPORT_TOKEN;
// Gemini CLI's optional environment redaction removes every variable whose
// name contains TOKEN before it runs a hook. Say so instead of staying silent.
if (!inSession && env.AGENT_GUILD_SESSION_ID && !env.AGENT_GUILD_REPORT_TOKEN) {
  console.error('agent-guild-report: AGENT_GUILD_REPORT_TOKEN is missing from the environment; the tool may be redacting variables named *TOKEN*');
}

const USAGE = `Usage: agent-guild-report <agent-id> [--name N] [--status working|waiting|idle|done] [--detail TEXT] [--kind KIND] [--remove]
       agent-guild-report --model NAME [--display-name TEXT]
       agent-guild-report --hook                           (reads a coding tool's hook event JSON from stdin)
       agent-guild-report --claude-statusline [--passthrough]  (reads Claude Code status line JSON from stdin)`;

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remove') out.remove = true;
    else if (a === '--hook' || a === '--claude-hook') out.hook = true;
    else if (a === '--claude-statusline') out.claudeStatusline = true;
    else if (a === '--passthrough') out.passthrough = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out.positional.push(a);
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

async function send(report) {
  const kind = report.agentId !== undefined ? 'agents' : 'model';
  const url = `${env.AGENT_GUILD_URL}/api/v1/sessions/${env.AGENT_GUILD_SESSION_ID}/${kind}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Guild-Report-Token': env.AGENT_GUILD_REPORT_TOKEN,
    },
    body: JSON.stringify(report),
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
}

/** A hook must never break the coding tool, so report failures quietly. */
const sendQuietly = (report) => send(report).catch((err) => console.error(`agent-guild-report: ${err.message}`));

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.hook) {
    const input = parseJson(await readStdin());
    if (!inSession || !input) return;
    for (const report of hookToReports(input)) await sendQuietly(report);
    return;
  }
  if (args.claudeStatusline) {
    const raw = await readStdin();
    const input = parseJson(raw);
    process.stdout.write(args.passthrough ? raw : `${formatStatusLine(input)}\n`);
    if (!inSession || !input) return;
    const report = claudeStatuslineToReport(input);
    if (report) await sendQuietly(report);
    return;
  }
  if (args.model !== undefined && args.positional.length === 0) {
    if (!args.model) {
      console.error('agent-guild-report: --model needs a name');
      process.exitCode = 2;
      return;
    }
    if (!inSession) return;
    await send({ model: args.model, displayName: args['display-name'] });
    return;
  }
  const agentId = args.positional[0];
  if (!agentId) {
    console.error('agent-guild-report: an agent id is required (see --help)');
    process.exitCode = 2;
    return;
  }
  if (!inSession) return;
  const report = { agentId };
  for (const key of ['name', 'status', 'detail', 'kind']) if (args[key] !== undefined) report[key] = args[key];
  if (args.remove) report.remove = true;
  await send(report);
}

main().catch((err) => {
  console.error(`agent-guild-report: ${err.message}`);
  process.exitCode = 1;
});
