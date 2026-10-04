// Ranking and highlighting for the GitHub panel's repository picker, kept free of the page so tests can run it.

const RECENT_MAX = 8;

function haystack(repo) {
  return [repo.fullName, repo.name, repo.description, repo.language, repo.login].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Every whitespace-separated word must appear in the owner/name, description,
 * language or account login. A name that starts with the whole query ranks
 * first, then owner/name containing it, then the rest; ties go to the latest push.
 * An empty query keeps every repository, latest push first.
 */
export function rankRepos(repos, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const ranked = [];
  for (const repo of repos) {
    if (!words.length) {
      ranked.push({ repo, rank: 3 });
      continue;
    }
    if (!words.every((word) => haystack(repo).includes(word))) continue;
    const rank = String(repo.name ?? '').toLowerCase().startsWith(q) ? 0 : String(repo.fullName ?? '').toLowerCase().includes(q) ? 1 : 2;
    ranked.push({ repo, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank
    || (Date.parse(b.repo.pushedAt) || 0) - (Date.parse(a.repo.pushedAt) || 0)
    || String(a.repo.fullName).localeCompare(String(b.repo.fullName))
    || String(a.repo.accountId).localeCompare(String(b.repo.accountId)));
  return ranked.map((item) => item.repo);
}

/** One repository as seen by one account: the same repository through two accounts is two picks. */
export function repoKey(repo) {
  return `${repo.accountId}:${repo.fullName}`;
}

/** Up to eight recent picks first, then the rest in their order, each once. */
export function recentFirst(repos, keys) {
  const byKey = new Map(repos.map((repo) => [repoKey(repo), repo]));
  const pinned = [];
  const seen = new Set();
  for (const key of Array.isArray(keys) ? keys : []) {
    const repo = byKey.get(key);
    if (!repo || seen.has(key)) continue;
    pinned.push(repo);
    seen.add(key);
    if (pinned.length === RECENT_MAX) break;
  }
  return [...pinned, ...repos.filter((repo) => !seen.has(repoKey(repo)))];
}

/** The keys with `repo` moved to the front, at most eight. */
export function remember(keys, repo) {
  const key = repoKey(repo);
  return [key, ...(Array.isArray(keys) ? keys : []).filter((k) => k !== key)].slice(0, RECENT_MAX);
}

/** The pick for a folder's origin (lowercase owner/name): the account picked most recently, else the first that has it. */
export function repoForOrigin(repos, origin, keys = []) {
  if (!origin) return null;
  const matches = repos.filter((repo) => String(repo.fullName).toLowerCase() === origin);
  if (!matches.length) return null;
  const order = Array.isArray(keys) ? keys : [];
  return recentFirst(matches, order)[0];
}

/** Splits text into matched and unmatched runs for the query's words, matched literally. */
export function highlightParts(text, query) {
  const source = String(text ?? '');
  const words = String(query ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!source || !words.length) return [{ match: false, text: source }];
  const lower = source.toLowerCase();
  const marks = new Array(source.length).fill(false);
  for (const word of words) {
    for (let at = lower.indexOf(word); at !== -1; at = lower.indexOf(word, at + word.length)) {
      marks.fill(true, at, at + word.length);
    }
  }
  const parts = [];
  let start = 0;
  for (let i = 1; i <= source.length; i++) {
    if (i === source.length || marks[i] !== marks[start]) {
      parts.push({ match: marks[start], text: source.slice(start, i) });
      start = i;
    }
  }
  return parts;
}
