// Branches, Issues, Actions runs and open pull requests of one repository, read with a
// signed-in account. Reading and editing stay shallow: GitHub's page is the full view.

import { nextLink, parseRepo } from './github.mjs';

const PAGE = 30;
const RUNNING = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const WEB = 'https://github.com';
const ISSUE_RE = /^[1-9]\d{0,9}$/;
const STATUS_PAGE = 'https://www.githubstatus.com';
const STATUS_TTL_MS = 60 * 1000;
const STATUS_TIMEOUT_MS = 5000;
const OUTAGES = new Set(['degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']);

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** A github.com page, or the fallback built from checked parts. */
export function githubUrl(value, fallback) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'github.com') return url.href;
  } catch { /* the fallback */ }
  return fallback;
}

function text(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function time(value) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function loginOf(user) {
  return typeof user?.login === 'string' && user.login.trim() ? user.login.trim().slice(0, 80) : 'unknown';
}

function cleanIssue(raw, fullName) {
  const number = raw?.number;
  if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(number) || number < 1) return null;
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null;
  return {
    number,
    title: raw.title.trim().slice(0, 256),
    body: text(raw.body, 65536),
    state: raw.state === 'closed' ? 'closed' : 'open',
    user: loginOf(raw.user),
    comments: Number.isSafeInteger(raw.comments) ? raw.comments : 0,
    updatedAt: time(raw.updated_at),
    url: githubUrl(raw.html_url, `${WEB}/${fullName}/issues/${number}`),
  };
}

function cleanRun(raw, fullName) {
  const id = raw?.id;
  if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(id) || id < 1) return null;
  return {
    id,
    name: text(raw.name, 200) || text(raw.display_title, 200) || 'Workflow',
    title: text(raw.display_title, 300) || text(raw.name, 300) || 'Workflow run',
    branch: text(raw.head_branch, 200),
    event: text(raw.event, 40),
    status: typeof raw.status === 'string' ? raw.status.slice(0, 40) : 'unknown',
    conclusion: typeof raw.conclusion === 'string' ? raw.conclusion.slice(0, 40) : null,
    runNumber: Number.isSafeInteger(raw.run_number) ? raw.run_number : null,
    updatedAt: time(raw.updated_at),
    url: githubUrl(raw.html_url, `${WEB}/${fullName}/actions/runs/${id}`),
  };
}

function cleanPull(raw, fullName) {
  const number = raw?.number;
  if (!raw || typeof raw !== 'object' || !Number.isSafeInteger(number) || number < 1) return null;
  if (typeof raw.title !== 'string' || !raw.title.trim()) return null;
  return {
    number,
    title: raw.title.trim().slice(0, 256),
    draft: raw.draft === true,
    user: loginOf(raw.user),
    head: text(raw.head?.ref, 200),
    base: text(raw.base?.ref, 200),
    updatedAt: time(raw.updated_at),
    url: githubUrl(raw.html_url, `${WEB}/${fullName}/pull/${number}`),
  };
}

/** The Actions part of a githubstatus.com summary: null while it is operational or unreadable. */
export function actionsService(summary) {
  const component = (Array.isArray(summary?.components) ? summary.components : []).find((c) => c?.name === 'Actions' && !c.group_id);
  if (!component || !OUTAGES.has(component.status)) return null;
  const incident = (Array.isArray(summary.incidents) ? summary.incidents : [])
    .find((i) => Array.isArray(i?.components) && i.components.some((c) => c?.id === component.id));
  const name = text(incident?.name, 200).trim();
  return {
    status: component.status,
    incident: name ? { name, url: /^[a-z0-9]{1,32}$/.test(incident.id) ? `${STATUS_PAGE}/incidents/${incident.id}` : STATUS_PAGE } : null,
    url: STATUS_PAGE,
  };
}

function checkTitle(title) {
  if (typeof title !== 'string' || !title.trim()) throw refusal(400, 'bad_title', 'title must be a non-empty string');
  if (title.trim().length > 256) throw refusal(400, 'bad_title', 'Keep the title to 256 characters or fewer.');
  return title.trim();
}

function checkBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof body !== 'string') throw refusal(400, 'bad_body', 'body must be a string');
  if (body.length > 48000) throw refusal(400, 'bad_body', 'Keep the description to 48,000 characters or fewer, or edit it on GitHub.');
  return body;
}

export function createViews(github, { now = Date.now } = {}) {
  let service = null;

  /** GitHub's own word on Actions, read without an account and shared by every repository for a minute. */
  function actionsStatus() {
    if (service && now() - service.at < STATUS_TTL_MS) return service.read;
    const read = github.fetchImpl(`${github.statusUrl}/api/v2/summary.json`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    }).then((res) => (res.ok ? res.json() : null)).then(actionsService, () => null);
    service = { at: now(), read };
    return read;
  }

  /** One request for the repository's account. GitHub's own refusals become answers the page can show as they are. */
  async function call(accountId, owner, name, route, init) {
    const account = github.account(accountId);
    const repo = parseRepo(`${owner ?? ''}/${name ?? ''}`);
    try {
      const { body, res } = await github._apiJson(account, `/repos/${repo.owner}/${repo.name}${route}`, init);
      return { body, res, repo };
    } catch (err) {
      if (err.limited) throw refusal(429, 'rate_limited', err.message);
      if (err.github === 404) throw refusal(404, 'not_found', `GitHub could not find ${repo.fullName} for @${account.login}`);
      if (err.github === 410) throw refusal(404, 'issues_disabled', `Issues are turned off for ${repo.fullName}`);
      if (err.github === 403) throw refusal(403, 'forbidden', `GitHub did not let @${account.login} do that in ${repo.fullName}`);
      if (err.github === 422) throw refusal(400, 'github_rejected', err.message);
      throw err;
    }
  }

  return {
    async branches(accountId, owner, name, { page = '1' } = {}) {
      if (!/^[1-9]\d*$/.test(String(page)) || !Number.isSafeInteger(Number(page))) {
        throw refusal(400, 'bad_page', 'page must be a positive integer');
      }
      page = Number(page);
      // One metadata read per listing, never a protection request per branch.
      const [listing, metadata] = await Promise.all([
        call(accountId, owner, name, `/branches?per_page=100&page=${page}`),
        page === 1 ? call(accountId, owner, name, '').then(({ body }) => ({ body }), (error) => ({ error: error.message })) : null,
      ]);
      const { body, res, repo } = listing;
      if (!Array.isArray(body)) throw refusal(502, 'github_error', 'GitHub did not return a branch list');
      let nextPage = null;
      const next = nextLink(res.headers.get('link'));
      if (next) {
        // Reconstruct our own route; never send credentials to a supplied Link URL.
        try { nextPage = Number(new URL(next).searchParams.get('page')); } catch { /* rejected below */ }
        if (!Number.isSafeInteger(nextPage) || nextPage <= page) {
          throw refusal(502, 'github_error', 'GitHub returned an invalid next page for branches');
        }
      }
      const branches = body.filter((item) => typeof item?.name === 'string' && item.name.length > 0).map((item) => ({
        name: item.name,
        sha: typeof item.commit?.sha === 'string' && /^[a-f0-9]{40,64}$/i.test(item.commit.sha) ? item.commit.sha : null,
        protected: item.protected === true,
        url: `${WEB}/${repo.fullName}/tree/${encodeURIComponent(item.name)}`,
      }));
      return {
        branches, nextPage,
        defaultBranch: typeof metadata?.body?.default_branch === 'string' ? metadata.body.default_branch : null,
        metadataError: metadata?.error ?? null,
        fetchedAt: new Date().toISOString(),
        url: `${WEB}/${repo.fullName}/branches`,
      };
    },

    async issues(accountId, owner, name, { state = 'open' } = {}) {
      if (state !== 'open' && state !== 'closed' && state !== 'all') throw refusal(400, 'bad_state', 'state must be open, closed or all');
      const { body, res, repo } = await call(accountId, owner, name, `/issues?state=${state}&per_page=${PAGE}&sort=updated&direction=desc`);
      return {
        issues: (Array.isArray(body) ? body : []).filter((item) => item && !item.pull_request).map((item) => cleanIssue(item, repo.fullName)).filter(Boolean),
        truncated: Boolean(nextLink(res.headers.get('link'))),
        url: `${WEB}/${repo.fullName}/issues`,
      };
    },

    async createIssue(accountId, owner, name, { title, body } = {}) {
      const payload = { title: checkTitle(title), body: checkBody(body) };
      const { body: created, repo } = await call(accountId, owner, name, '/issues', { method: 'POST', body: JSON.stringify(payload) });
      const issue = cleanIssue(created, repo.fullName);
      if (!issue) throw refusal(502, 'github_error', 'GitHub did not describe the new issue');
      return issue;
    },

    async updateIssue(accountId, owner, name, number, patch = {}) {
      if (!ISSUE_RE.test(String(number ?? ''))) throw refusal(400, 'bad_issue', 'issue number must be a positive integer');
      const payload = {};
      if (patch.title !== undefined) payload.title = checkTitle(patch.title);
      if (patch.body !== undefined) payload.body = checkBody(patch.body);
      if (patch.state !== undefined) {
        if (patch.state !== 'open' && patch.state !== 'closed') throw refusal(400, 'bad_state', 'state must be open or closed');
        payload.state = patch.state;
      }
      if (Object.keys(payload).length === 0) throw refusal(400, 'bad_request', 'nothing to update');
      const { body, repo } = await call(accountId, owner, name, `/issues/${Number(number)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      const issue = cleanIssue(body, repo.fullName);
      if (!issue) throw refusal(502, 'github_error', 'GitHub did not describe the issue');
      return issue;
    },

    async actions(accountId, owner, name) {
      const [{ body, res, repo }, outage] = await Promise.all([call(accountId, owner, name, `/actions/runs?per_page=${PAGE}`), actionsStatus()]);
      const runs = (Array.isArray(body?.workflow_runs) ? body.workflow_runs : []).map((item) => cleanRun(item, repo.fullName)).filter(Boolean);
      return {
        runs,
        running: runs.some((run) => RUNNING.has(run.status)),
        service: outage,
        truncated: Boolean(nextLink(res.headers.get('link'))),
        url: `${WEB}/${repo.fullName}/actions`,
      };
    },

    async pulls(accountId, owner, name) {
      const { body, res, repo } = await call(accountId, owner, name, `/pulls?state=open&per_page=${PAGE}&sort=updated&direction=desc`);
      return {
        pulls: (Array.isArray(body) ? body : []).map((item) => cleanPull(item, repo.fullName)).filter(Boolean),
        truncated: Boolean(nextLink(res.headers.get('link'))),
        url: `${WEB}/${repo.fullName}/pulls`,
      };
    },
  };
}
