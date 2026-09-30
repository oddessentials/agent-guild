#!/usr/bin/env node
// Report an agent working inside an Agent Guild session.
//
// The session manager injects AGENT_GUILD_URL, AGENT_GUILD_SESSION_ID and
// AGENT_GUILD_REPORT_TOKEN into every terminal it starts. Outside such a
// terminal this command does nothing and exits 0, so hooks that call it are
// harmless when the tool runs elsewhere.
//
//   agent-guild-report <agent-id> [--name N] [--status working|waiting|idle|done]
//                      [--detail TEXT] [--kind KIND] [--remove]
//   agent-guild-report --claude-hook      (reads Claude Code hook JSON on stdin)

import { claudeHookToReport } from '../src/report/claude-hook.mjs';

const env = process.env;
const inSession = env.AGENT_GUILD_URL && env.AGENT_GUILD_SESSION_ID && env.AGENT_GUILD_REPORT_TOKEN;

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remove') out.remove = true;
    else if (a === '--claude-hook') out.claudeHook = true;
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
  const url = `${env.AGENT_GUILD_URL}/api/v1/sessions/${env.AGENT_GUILD_SESSION_ID}/agents`;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: agent-guild-report <agent-id> [--name N] [--status working|waiting|idle|done] [--detail TEXT] [--kind KIND] [--remove]\n' +
      '       agent-guild-report --claude-hook   (reads Claude Code hook JSON from stdin)');
    return;
  }
  if (args.claudeHook) {
    const raw = await readStdin();
    if (!inSession) return;
    let input;
    try { input = JSON.parse(raw); } catch { return; }
    const report = claudeHookToReport(input);
    // A hook must never break the coding tool, so report failures quietly.
    if (report) await send(report).catch((err) => console.error(`agent-guild-report: ${err.message}`));
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
