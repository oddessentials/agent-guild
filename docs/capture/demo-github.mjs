// A stand-in for GitHub's API with one signed-in account, for the capture's
// GitHub panel shot. It answers only what the panel reads.

import http from 'node:http';

export const DEMO_ACCOUNT = {
  id: 1001, login: 'demo-dev', name: 'Demo Developer', avatar: null, scopes: ['repo', 'write:public_key'], needsSignIn: false,
  addedAt: '2026-09-01T09:00:00.000Z', ssh: { verifiedAt: null },
  token: { access: 'demo-token', expiresAt: null, refresh: null, refreshExpiresAt: null },
};

/** The repositories the capture's session folders are clones of. */
export const DEMO_REPOS = ['storefront', 'billing', 'api-gateway', 'docs-site', 'game-engine'].map((name) => `acme/${name}`);

const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const web = (fullName, rest) => `https://github.com/${fullName}/${rest}`;

function views(fullName) {
  const issue = (number, title, user, minutes, comments, state = 'open') => ({ number, title, state, body: '', user: { login: user }, comments, updated_at: ago(minutes), html_url: web(fullName, `issues/${number}`) });
  const run = (id, name, title, branch, event, status, conclusion, number, minutes) => ({ id, name, display_title: title, head_branch: branch, event, status, conclusion, run_number: number, updated_at: ago(minutes), html_url: web(fullName, `actions/runs/${id}`) });
  const pull = (number, title, draft, user, head, minutes) => ({ number, title, draft, state: 'open', user: { login: user }, head: { ref: head }, base: { ref: 'main' }, updated_at: ago(minutes), html_url: web(fullName, `pull/${number}`) });
  if (fullName !== 'acme/storefront') return { issues: [issue(3, 'Tidy the README', 'demo-dev', 900, 0)], runs: [run(501, 'CI', 'Tidy the README', 'main', 'push', 'completed', 'success', 31, 880)], pulls: [] };
  return {
    issues: [
      issue(42, 'Wallet payment fails for saved cards', 'demo-dev', 25, 3),
      issue(39, 'Checkout button overlaps the cart total on phones', 'priya', 180, 1),
      issue(35, 'Add order confirmation emails', 'sam', 1440, 5),
      issue(33, 'Show delivery estimates in the cart', 'lee', 2900, 2),
      issue(31, 'Coupon codes are case sensitive', 'demo-dev', 4320, 2, 'closed'),
    ],
    runs: [
      run(9004, 'CI', 'Retry wallet payments once', 'wallet-payments', 'pull_request', 'in_progress', null, 214, 2),
      run(9003, 'Deploy preview', 'Retry wallet payments once', 'wallet-payments', 'pull_request', 'queued', null, 89, 2),
      run(9002, 'CI', 'Tidy the cart layout', 'main', 'push', 'completed', 'success', 213, 95),
      run(9001, 'Deploy preview', 'Tidy the cart layout', 'main', 'push', 'completed', 'failure', 88, 100),
      run(9000, 'CodeQL', 'Weekly scan', 'main', 'schedule', 'completed', 'success', 52, 1500),
    ],
    pulls: [
      pull(43, 'Retry wallet payments once before failing', false, 'demo-dev', 'wallet-payments', 3),
      pull(40, 'New checkout layout', true, 'priya', 'checkout-layout', 600),
    ],
  };
}

export function demoGitHubAnswer(method, pathname, searchParams) {
  if (method === 'GET' && pathname === '/user') return { id: DEMO_ACCOUNT.id, login: DEMO_ACCOUNT.login, name: DEMO_ACCOUNT.name };
  if (method === 'GET' && pathname === '/user/repos') {
    return DEMO_REPOS.map((fullName, i) => ({ full_name: fullName, owner: { type: 'Organization' }, private: true, description: null, pushed_at: ago(10 + i * 90) }));
  }
  const match = /^\/repos\/(acme\/[^/]+)\/(issues|actions\/runs|pulls)$/.exec(pathname);
  if (method !== 'GET' || !match || !DEMO_REPOS.includes(match[1])) return null;
  const data = views(match[1]);
  if (match[2] === 'actions/runs') return { total_count: data.runs.length, workflow_runs: data.runs };
  if (match[2] === 'pulls') return data.pulls;
  const state = searchParams.get('state') || 'open';
  return data.issues.filter((i) => state === 'all' || i.state === state);
}

export async function startDemoGitHub() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = req.headers.authorization === `Bearer ${DEMO_ACCOUNT.token.access}` ? demoGitHubAnswer(req.method, url.pathname, url.searchParams) : null;
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body ?? { message: 'Not Found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
