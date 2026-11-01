import { hookRoute, hookToReports, dockerHookEvent, antigravityUserConversation } from './hooks.mjs';
import * as transcripts from './transcripts.mjs';

export function reportKind(report) {
  if (report.compaction !== undefined) return 'context';
  if (report.reply !== undefined) return 'reply';
  if (report.shell !== undefined) return 'shells';
  if (report.agentId !== undefined || report.finishForeground === true) return 'agents';
  if (report.hello === true) return 'reporting';
  if (report.toolSessionId !== undefined) return 'tool-session';
  return 'model';
}

export async function handleHookEvent(input, { reporting = '', event = null, since = Date.now() - 2000, send, files = transcripts, sleep } = {}) {
  const none = { later: Promise.resolve() };
  if (!input || typeof input !== 'object') return none;
  if (event && input.hook_event_name === undefined) input.hook_event_name = event;
  const route = hookRoute(input, reporting);
  if (!route) return none;
  // Docker Agent's events go whole to the manager, which tells its sessions (tabs, sub-agents) apart.
  if (route === 'docker') {
    const docker = dockerHookEvent(input);
    if (docker) await send(docker, 'docker');
    return none;
  }
  // Antigravity CLI runs the hook in its sub-agents too, each a conversation of its own.
  if (typeof input.conversationId === 'string' && !antigravityUserConversation(await files.firstRecord(input.transcriptPath))) return none;
  const later = [];
  for (const report of hookToReports(input)) {
    if (report.transcript === undefined) await send(report, reportKind(report));
    else {
      later.push(files.claudeCompaction(report.transcript, since, sleep ? { sleep } : undefined)
        .then((key) => (key ? send({ compaction: report.compaction, key }, 'context') : undefined)));
    }
  }
  if (typeof input.conversationId === 'string' && input.hook_event_name === 'Stop') {
    await send({ reply: await files.antigravityTranscriptReply(input.transcriptPath) }, 'reply');
  }
  return { later: Promise.all(later).then(() => {}) };
}
