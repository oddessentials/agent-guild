// The API explorer's only list of routes is docs/api.md itself: its HTTP endpoint table, read here row by row.

// `| METHOD | `path` | body | result |`, where the body may be empty or hold an escaped `\|`.
const ROW = /^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|((?:\\.|[^|\\])*)\| (.*) \|$/;

/** Every row of the HTTP endpoint table: `{ method, path, params, query, body, result }`, in the doc's order. */
export function endpoints(markdown) {
  return markdown.split(/\r?\n/).map((line) => line.match(ROW)).filter(Boolean).map(([, method, route, body, result]) => {
    const [path, search = ''] = route.split('?');
    return {
      method,
      path,
      params: [...path.matchAll(/:([a-z]+)/gi)].map(([, name]) => name),
      query: search ? search.split('&').map((pair) => pair.split('=')[0]).filter(Boolean) : [],
      body: body.trim().replaceAll('\\|', '|'),
      result: result.trim(),
    };
  });
}

// The GET routes the explorer sends. Each returns the manager's own state and starts no more work than opening
// the page does. The others are shown, not sent: some GETs run a tool, read files, or ask an outside service.
export const READS = new Set([
  '/health', '/info', '/sign-in', '/remote-access', '/notes', '/providers', '/news', '/yard-art', '/changelog',
  '/github', '/sessions', '/sessions/:id', '/sessions/:id/reply',
]);

// The sockets the explorer listens to. It sends nothing on them, and a terminal is opened without `page`,
// so it can never claim or resize one.
export const SOCKETS = new Set(['/events', '/sessions/:id/terminal']);
