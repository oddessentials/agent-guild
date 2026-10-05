// Browser-only simulation of the local manager API. This file is included in
// the generated Pages demo, never in Agent Guild's installed web client.
(function () {
  'use strict';

  var version = window.AGENT_GUILD_DEMO_VERSION || '0.0.0-demo';
  var now = Date.now();
  var providers = [
    provider('anthropic', 'Anthropic', 'Claude Code', '#d97757', 'A', true),
    provider('openai', 'OpenAI', 'Codex CLI', '#10a37f', 'O', true),
    provider('google', 'Google', 'Antigravity CLI', '#4285f4', 'G', false),
    provider('xai', 'xAI', 'Grok Build', '#111827', 'X', false),
    provider('shell', 'Local', 'Shell', '#64748b', '>', false),
  ];
  var home = '/Users/demo';
  var labels = { npm: 'npm', native: 'native', brew: 'Homebrew' };
  var copies = {
    anthropic: [
      copy('native', home + '/.local/bin/claude', true, null, [home + '/.local/bin/claude', home + '/.local/share/claude']),
      copy('npm', home + '/.npm-global/bin/claude', false, home + '/.npm-global/bin/npm uninstall -g --prefix ' + home + '/.npm-global @anthropic-ai/claude-code', []),
    ],
    openai: [copy('brew', '/opt/homebrew/bin/codex', true, '/opt/homebrew/bin/brew uninstall --cask codex', [])],
    google: [copy('native', home + '/.local/bin/agy', true, null, [home + '/.local/bin/agy'])],
    xai: [copy('native', home + '/.grok/bin/grok', true, null, [home + '/.grok/bin', home + '/.grok/downloads', home + '/.grok/completions'])],
  };
  providers.forEach(syncInstalls);
  providers[4].shells = [{ id: 'zsh', label: 'zsh', path: '/bin/zsh', multiplexer: false }];
  providers[4].defaultShell = 'zsh';
  var environment = {
    scope: 'manager', platform: 'darwin', revision: 1, refreshing: false, checkedAt: new Date(now).toISOString(), error: null,
    managerNode: { version: '24.0.0', path: '/demo/bin/node' },
    runtimes: [
      { id: 'node', label: 'Node.js', command: 'node', status: 'ok', version: '24.0.0', path: '/demo/bin/node' },
      { id: 'python', label: 'Python', command: 'python3', status: 'ok', version: '3.14.0', path: '/demo/bin/python3' },
      { id: 'go', label: 'Go', command: 'go', status: 'ok', version: '1.25.0', path: '/demo/bin/go' },
      { id: 'dotnet', label: '.NET SDK', command: 'dotnet', status: 'not_found', version: null, path: null },
      { id: 'r', label: 'R', command: 'R', status: 'not_found', version: null, path: null },
      { id: 'rust', label: 'Rust', command: 'rustc', status: 'ok', version: '1.90.0', path: '/demo/bin/rustc' },
    ],
    tools: [{ id: 'uv', label: 'uv', path: '/demo/bin/uv', status: 'detected' }],
  };
  providers[4].multiplexers = ['tmux', 'herdr'].map(function (id) {
    return { id: id, tool: id, checked: true, available: false, installable: true, installs: [], busy: false, pendingCards: 0, installCommand: 'Simulate installing ' + id };
  });

  function provider(id, vendor, tool, color, monogram, metered) {
    return {
      id: id, vendor: vendor, tool: tool, color: color, monogram: monogram, iconUrl: null,
      command: id, package: null, args: [], resumable: id !== 'shell', installable: false,
      installedVersion: id === 'shell' ? null : '1.0.0', versionStatus: 'ok', versionError: null,
      latestVersion: id === 'shell' ? null : '1.0.0', updateAvailable: false, installChannel: null,
      updateCommand: null, updateGuidance: null, lastInstall: null, installs: [], warnings: [], npmNote: null,
      usageSource: metered ? 'command' : null, historySource: id === 'shell' ? null : 'command',
      reporting: null, reportingEnabled: null,
      accounts: id === 'anthropic' ? [{ id: 'default', label: 'Personal' }, { id: 'work', label: 'Work' }] : [{ id: 'default', label: 'Default' }],
      modelPattern: null, install: null, docs: null, usageUrl: null, billingUrl: null, cloudUrl: null,
      available: true, resolvedPath: '/demo/bin/' + id,
    };
  }

  function shown(file) { return file.indexOf(home + '/') === 0 ? '~' + file.slice(home.length) : file; }

  function copy(channel, file, active, command, remove) {
    return {
      path: file, displayPath: shown(file), channel: channel, version: '1.0.0', versionStatus: 'ok', active: active, onPath: true,
      uninstall: { command: command, remove: remove.map(shown) }, remove: remove,
    };
  }

  // Mirrors the manager: the copy list, its warning, and whether the tool is still found.
  function syncInstalls(p) {
    var list = copies[p.id] || [];
    if (list.length > 0 && !list.some(function (c) { return c.active; })) list[0].active = true;
    var active = list.find(function (c) { return c.active; });
    p.installs = list.map(function (c) {
      return { path: c.path, displayPath: c.displayPath, channel: c.channel, version: c.version, versionStatus: c.versionStatus, active: c.active, onPath: c.onPath, uninstall: c.uninstall };
    });
    p.warnings = list.length > 1 ? [list.length + ' copies of ' + p.tool + ' are installed. The one in use is ' + labels[active.channel] + ' v' + active.version + ' at ' + active.displayPath + '.'] : [];
    if (p.id === 'shell') return;
    p.available = Boolean(active);
    p.installChannel = active ? active.channel : null;
    p.resolvedPath = active ? active.path : null;
    p.installedVersion = active ? active.version : null;
    p.versionStatus = active ? 'ok' : null;
  }

  function uninstallTranscript(c) {
    var lines = c.uninstall.command ? ['> ' + c.uninstall.command, 'removed 1 package in 1s'] : [];
    c.remove.forEach(function (file) { lines.push('Removed ' + file); });
    return '\u001b[1;36mAgent Guild interactive demo\u001b[0m\r\n\r\n' + lines.join('\r\n') +
      '\r\n\r\n\u001b[2m[demo only — nothing was removed from your computer]\u001b[0m\r\n';
  }

  function session(id, providerId, name, folder, model, agents) {
    var p = providers.find(function (item) { return item.id === providerId; });
    return {
      id: id, name: name, provider: { id: p.id, vendor: p.vendor, tool: p.tool, color: p.color, monogram: p.monogram, iconUrl: null },
      cwd: '/work/' + folder, resume: null, task: null, account: { id: 'default', label: 'Default' }, clone: null,
      pid: null, status: 'running', exitCode: null, signal: null, activity: 'active',
      lastOutputAt: new Date(now - 20 * 1000).toISOString(), createdAt: new Date(now - 24 * 60 * 1000).toISOString(), exitedAt: null,
      cols: 120, rows: 32, attachedClients: 0,
      model: model ? { name: model, displayName: model, source: 'report' } : null,
      toolSessionId: 'demo-' + id, reporting: { state: 'active', reason: null },
      agents: (agents || []).map(function (name, i) { return { id: id + '-agent-' + i, name: name, status: i % 2 ? 'waiting' : 'working', detail: null }; }),
      shells: providerId === 'shell' ? [{ id: id + '-shell' }] : [],
    };
  }

  var sessions = [
    session('a11ce001', 'anthropic', 'Checkout: wallet payments', 'storefront', 'Claude Sonnet', ['Explore', 'Test writer', 'Reviewer']),
    session('c0de0002', 'openai', 'Gateway rate limits', 'api-gateway', 'GPT-5 Codex', ['Worker', 'Tests']),
    session('600d0003', 'google', 'Docs site migration', 'docs-site', 'Gemini Pro', ['Researcher']),
    session('5he11004'.replace('h', 'b'), 'shell', 'Storefront dev server', 'storefront', null, []),
  ];
  var eventSockets = [];
  var transcripts = {};

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
  }
  function error(message, code, status) { return json({ error: { message: message, code: code } }, status || 400); }
  // Events arrive after the request that caused them returns, as from the manager,
  // so a page handler that throws never fails the request itself.
  function announce(message) {
    var data = JSON.stringify(message);
    setTimeout(function () { eventSockets.forEach(function (socket) { socket.emit({ data: data }); }); }, 0);
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.includes('/api/v1/')) return realFetch(input, init);
    var route = url.pathname.slice(url.pathname.indexOf('/api/v1/') + 7);
    var method = (init && init.method || 'GET').toUpperCase();
    var body = init && init.body ? JSON.parse(init.body) : {};

    if (route === '/providers' && method === 'GET') return json({ providers: clone(providers) });
    if (route === '/environment' && method === 'GET') return json(clone(environment));
    if (route === '/environment/refresh' && method === 'POST') {
      environment.revision++;
      environment.checkedAt = new Date().toISOString();
      announce({ type: 'environment.updated', environment: clone(environment) });
      return json(clone(environment), 202);
    }
    if (route === '/providers/reload' && method === 'POST') return json({ providers: clone(providers), warnings: [] });
    if (route === '/usage' && method === 'GET') return json({ usage: [
      { providerId: 'anthropic', accountId: 'default', signedIn: true, plan: 'pro', windows: [{ label: '5 hours', usedPercent: 36, resetsAt: new Date(now + 2 * 3600000).toISOString() }] },
      { providerId: 'anthropic', accountId: 'work', signedIn: true, plan: 'team', windows: [{ label: '5 hours', usedPercent: 18, resetsAt: new Date(now + 3 * 3600000).toISOString() }] },
      { providerId: 'openai', accountId: 'default', signedIn: true, plan: 'plus', windows: [{ label: 'Weekly', usedPercent: 43, resetsAt: new Date(now + 3 * 86400000).toISOString() }] },
    ] });
    if (route === '/model-stats' && method === 'GET') return json({ retrievedAt: new Date(now).toISOString(), stale: false, error: null, stats: [], pool: null, providers: {}, models: {}, sessions: {} });
    if (route === '/news' && method === 'GET') return json({ refreshing: false, updatedAt: new Date(now).toISOString(), items: [
      { id: 'demo-news', title: 'Agent Guild interactive demo', url: 'https://github.com/oddessentials/agent-guild', source: 'Agent Guild', kind: 'news', publishedAt: new Date(now - 3600000).toISOString(), summary: 'Explore the interface with simulated local sessions.' },
    ], sources: [] });
    if (route === '/changelog' && method === 'GET') return json({ refreshing: false, releases: [], okAt: new Date(now).toISOString(), error: null });
    if (route === '/folders' && method === 'GET') return json(folderListing(url.searchParams.get('path')));
    if (route === '/folders' && method === 'POST') return makeFolder(body);
    if (route.indexOf('/github') === 0) return githubRoute(route, method, body, url.searchParams);
    if (/^\/providers\/[^/]+\/history$/.test(route) && method === 'GET') return json({ history: [] });
    if (route === '/sessions' && method === 'POST') {
      var id = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
      var p = providers.find(function (item) { return item.id === body.providerId; }) || providers[4];
      var made = session(id, p.id, body.name || p.tool + ' demo', String(body.cwd || 'demo').replace(/^.*[\\/]/, ''), p.id === 'shell' ? null : 'Demo model', []);
      sessions.push(made); announce({ type: 'session.created', session: clone(made) });
      return json({ session: clone(made) }, 201);
    }
    var muxAction = route.match(/^\/providers\/shell\/multiplexers\/(tmux|herdr)\/(install|update|uninstall)$/);
    if (muxAction && method === 'POST') return manageMultiplexer(muxAction[1], muxAction[2], body);
    var removal = route.match(/^\/providers\/([^/]+)\/uninstall$/);
    if (removal && method === 'POST') return uninstall(removal[1], body);
    var match = route.match(/^\/sessions\/([a-f0-9]+)(?:\/(stop))?$/);
    if (match) {
      var at = sessions.findIndex(function (item) { return item.id === match[1]; });
      if (at < 0) return error('demo session not found', 'not_found', 404);
      if (method === 'PATCH') { sessions[at].name = String(body.name || sessions[at].name); announce({ type: 'session.updated', session: clone(sessions[at]) }); return json({ session: clone(sessions[at]) }); }
      if (method === 'POST' && match[2] === 'stop') { sessions[at].status = 'exited'; sessions[at].activity = 'quiet'; sessions[at].exitedAt = new Date().toISOString(); announce({ type: 'session.updated', session: clone(sessions[at]) }); return json({ session: clone(sessions[at]) }); }
      if (method === 'DELETE') { sessions.splice(at, 1); announce({ type: 'session.removed', sessionId: match[1] }); return json({}); }
    }
    return error('This action is unavailable in the simulated demo.', 'demo_only', 409);
  };

  // A signed-in GitHub account whose repositories hold the demo sessions' folders.
  var githubAccount = {
    id: 1001, login: 'demo-dev', name: 'Demo Developer', avatar: null, scopes: ['repo', 'write:public_key'], needsSignIn: false,
    addedAt: new Date(now - 30 * 86400000).toISOString(),
    ssh: { status: 'ready', key: home + '/.config/agent-guild/github/keys/agent-guild-github-1001', publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyOnly agent-guild github demo-dev (1001)', verifiedAt: new Date(now - 86400000).toISOString(), settingUp: false, error: null },
  };
  function ago(minutes) { return new Date(now - minutes * 60000).toISOString(); }
  function githubRepo(fullName, description, language, pushed, extra) {
    var parts = fullName.split('/');
    return Object.assign({
      fullName: fullName, owner: parts[0], ownerType: parts[0] === 'acme' ? 'Organization' : 'User', name: parts[1],
      private: parts[0] === 'acme', fork: false, archived: false, description: description, language: language,
      pushedAt: ago(pushed), url: 'https://github.com/' + fullName,
    }, extra || {});
  }
  var githubRepos = [
    githubRepo('acme/storefront', 'Online shop with wallet checkout', 'TypeScript', 12),
    githubRepo('acme/api-gateway', 'Rate limits and routing for public APIs', 'Go', 50),
    githubRepo('acme/docs-site', 'Product documentation', 'MDX', 300),
    githubRepo('demo-dev/dotfiles', 'Shell and editor setup', 'Shell', 2000),
    githubRepo('demo-dev/old-prototype', 'First sketch of the shop', 'JavaScript', 90000, { archived: true }),
  ];
  var origins = { '/work/storefront': 'acme/storefront', '/work/api-gateway': 'acme/api-gateway', '/work/docs-site': 'acme/docs-site' };
  function issue(number, title, state, user, minutes, comments, text) {
    return { number: number, title: title, body: text || '', state: state, user: user, comments: comments, updatedAt: ago(minutes), url: '' };
  }
  function run(id, name, title, branch, event, status, conclusion, number, minutes) {
    return { id: id, name: name, title: title, branch: branch, event: event, status: status, conclusion: conclusion, runNumber: number, updatedAt: ago(minutes), url: '' };
  }
  function pull(number, title, draft, user, head, minutes) {
    return { number: number, title: title, draft: draft, user: user, head: head, base: 'main', updatedAt: ago(minutes), url: '' };
  }
  var repoViews = {
    'acme/storefront': {
      issues: [
        issue(42, 'Wallet payment fails for saved cards', 'open', 'demo-dev', 25, 3, 'Saved cards get a 402 from the wallet provider.'),
        issue(39, 'Checkout button overlaps the cart total on phones', 'open', 'priya', 180, 1),
        issue(35, 'Add order confirmation emails', 'open', 'sam', 1440, 5),
        issue(31, 'Coupon codes are case sensitive', 'closed', 'demo-dev', 4320, 2),
      ],
      runs: [
        run(9003, 'CI', 'Retry wallet payments once', 'wallet-payments', 'pull_request', 'in_progress', null, 214, 2),
        run(9002, 'CI', 'Tidy the cart layout', 'main', 'push', 'completed', 'success', 213, 95),
        run(9001, 'Deploy preview', 'Tidy the cart layout', 'main', 'push', 'completed', 'failure', 88, 100),
      ],
      pulls: [
        pull(43, 'Retry wallet payments once before failing', false, 'demo-dev', 'wallet-payments', 3),
        pull(40, 'New checkout layout', true, 'priya', 'checkout-layout', 600),
      ],
    },
    'acme/api-gateway': {
      issues: [issue(12, 'Per-key rate limits', 'open', 'demo-dev', 60, 4)],
      runs: [run(7001, 'CI', 'Sliding window limiter', 'rate-limits', 'push', 'completed', 'success', 57, 40)],
      pulls: [pull(13, 'Sliding window rate limiter', false, 'demo-dev', 'rate-limits', 45)],
    },
  };
  Object.keys(repoViews).forEach(function (name) {
    var v = repoViews[name];
    v.issues.forEach(function (i) { i.url = 'https://github.com/' + name + '/issues/' + i.number; });
    v.runs.forEach(function (r) { r.url = 'https://github.com/' + name + '/actions/runs/' + r.id; });
    v.pulls.forEach(function (p) { p.url = 'https://github.com/' + name + '/pull/' + p.number; });
  });

  var folderTree = {
    '/': ['Users', 'work'], '/Users': ['demo'], '/Users/demo': ['.config', 'Desktop', 'Documents'],
    '/work': ['api-gateway', 'docs-site', 'storefront'],
  };

  function folderListing(asked) {
    var wanted = !asked || !asked.trim() || asked.trim() === '~' ? home : asked.trim().replace(/\/+$/, '') || '/';
    var known = Object.keys(folderTree).reduce(function (all, parent) {
      return all.concat(folderTree[parent].map(function (name) { return (parent === '/' ? '' : parent) + '/' + name; }));
    }, ['/']);
    var dir = wanted;
    while (known.indexOf(dir) === -1) dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
    var parts = dir.split('/').filter(Boolean);
    var segments = [{ name: '/', path: '/' }].concat(parts.map(function (part, i) { return { name: part, path: '/' + parts.slice(0, i + 1).join('/') }; }));
    return {
      path: dir, parent: dir === '/' ? null : dir.slice(0, dir.lastIndexOf('/')) || '/', home: home, segments: segments, roots: [{ name: '/', path: '/' }],
      entries: (folderTree[dir] || []).map(function (name) { return { name: name, path: (dir === '/' ? '' : dir) + '/' + name, hidden: name.charAt(0) === '.' }; }),
      truncated: false, note: dir === wanted ? null : wanted,
    };
  }

  function makeFolder(body) {
    var parent = String(body.path || '').replace(/\/+$/, '') || '/';
    var name = String(body.name || '').trim();
    if (!name || name === '.' || name === '..' || /[/\\\u0000-\u001f]/.test(name)) return error('Choose a different folder name.', 'bad_name', 400);
    if (folderListing(parent).path !== parent) return error(parent + ' no longer exists.', 'folder_missing', 409);
    var names = folderTree[parent] || (folderTree[parent] = []);
    if (names.indexOf(name) !== -1) return error(name + ' already exists in ' + parent + '.', 'folder_exists', 409);
    names.push(name);
    names.sort(function (a, b) { return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }); });
    return json(folderListing((parent === '/' ? '' : parent) + '/' + name), 201);
  }

  function githubSnapshot() {
    return {
      scopes: ['repo', 'write:public_key'],
      appUrl: 'https://github.com/settings/connections/applications/Ov23lif6qqYKtXZTb130',
      keysUrl: 'https://github.com/settings/keys',
      newKeyUrl: 'https://github.com/settings/ssh/new',
      tools: { git: true, ssh: true, sshKeygen: true },
      signIn: null,
      accounts: [clone(githubAccount)],
    };
  }

  function githubRoute(route, method, body, params) {
    if (route === '/github' && method === 'GET') return json({ github: githubSnapshot() });
    if (route === '/github/repos' && method === 'GET') {
      return json({ repos: githubRepos.map(function (r) { return Object.assign({ accountId: githubAccount.id, login: githubAccount.login }, r); }), truncated: false, errors: [], fetchedAt: new Date(now).toISOString() });
    }
    if (route === '/github/origin' && method === 'GET') {
      var folder = params.get('cwd') || home;
      return json({ folder: folder, repo: origins[folder] || null });
    }
    if (route === '/github/accounts/' + githubAccount.id + '/repos' && method === 'GET') {
      var parent = params.get('parent') || null;
      return json({ repos: {
        accountId: githubAccount.id, fetchedAt: new Date(now).toISOString(), truncated: false, owners: [githubAccount.login, 'acme'], parent: parent,
        repos: githubRepos.map(function (r) {
          var target = parent ? parent.replace(/[\\/]+$/, '') + '/' + r.name : null;
          return Object.assign({}, r, { target: target, local: target ? (origins['/work/' + r.name] && parent === '/work' ? 'cloned' : 'absent') : null });
        }),
      } });
    }
    var view = route.match(/^\/github\/accounts\/(\d+)\/repos\/([^/]+)\/([^/]+)\/(issues|actions|pulls)(?:\/(\d+))?$/);
    if (view) {
      if (Number(view[1]) !== githubAccount.id) return error('no GitHub account with id "' + view[1] + '" is signed in', 'unknown_account', 404);
      var fullName = decodeURIComponent(view[2]) + '/' + decodeURIComponent(view[3]);
      if (!githubRepos.some(function (r) { return r.fullName === fullName; })) return error('GitHub could not find ' + fullName + ' for @' + githubAccount.login, 'not_found', 404);
      var data = repoViews[fullName] || (repoViews[fullName] = { issues: [], runs: [], pulls: [] });
      var web = 'https://github.com/' + fullName;
      if (view[4] === 'actions' && !view[5] && method === 'GET') {
        return json({ runs: clone(data.runs), running: data.runs.some(function (r) { return r.status !== 'completed'; }), truncated: false, url: web + '/actions' });
      }
      if (view[4] === 'pulls' && !view[5] && method === 'GET') return json({ pulls: clone(data.pulls), truncated: false, url: web + '/pulls' });
      if (view[4] === 'issues' && !view[5] && method === 'GET') {
        var wanted = params.get('state') || 'open';
        if (['open', 'closed', 'all'].indexOf(wanted) < 0) return error('state must be open, closed or all', 'bad_state');
        return json({ issues: clone(data.issues.filter(function (i) { return wanted === 'all' || i.state === wanted; })), truncated: false, url: web + '/issues' });
      }
      var title = typeof body.title === 'string' ? body.title.trim() : undefined;
      if (view[4] === 'issues' && (method === 'POST' || method === 'PATCH')) {
        if (new TextEncoder().encode(JSON.stringify(body)).length > 64 * 1024) return error('request body too large', 'too_large', 413);
        if ((method === 'POST' || body.title !== undefined) && !title) return error('title must be a non-empty string', 'bad_title');
        if (title && title.length > 256) return error('Keep the title to 256 characters or fewer.', 'bad_title');
        if (body.body != null && typeof body.body !== 'string') return error('body must be a string', 'bad_body');
        if (body.body && body.body.length > 48000) return error('Keep the description to 48,000 characters or fewer, or edit it on GitHub.', 'bad_body');
      }
      if (view[4] === 'issues' && !view[5] && method === 'POST') {
        if (!title) return error('title must be a non-empty string', 'bad_title');
        var number = data.issues.reduce(function (n, i) { return Math.max(n, i.number); }, 0) + 1;
        var made = issue(number, title, 'open', githubAccount.login, 0, 0, body.body || '');
        made.url = web + '/issues/' + number;
        data.issues.unshift(made);
        return json({ issue: clone(made) }, 201);
      }
      if (view[4] === 'issues' && view[5] && method === 'PATCH') {
        var found = data.issues.find(function (i) { return i.number === Number(view[5]); });
        if (!found) return error('GitHub could not find ' + fullName + ' for @' + githubAccount.login, 'not_found', 404);
        if (body.title !== undefined && !title) return error('title must be a non-empty string', 'bad_title');
        if (body.state !== undefined && body.state !== 'open' && body.state !== 'closed') return error('state must be open or closed', 'bad_state');
        if (body.title === undefined && body.body === undefined && body.state === undefined) return error('nothing to update', 'bad_request');
        if (title) found.title = title;
        if (body.body !== undefined) found.body = body.body || '';
        if (body.state) found.state = body.state;
        found.updatedAt = new Date().toISOString();
        return json({ issue: clone(found) });
      }
    }
    return error('This action is unavailable in the simulated demo.', 'demo_only', 409);
  }

  function manageMultiplexer(toolId, kind, body) {
    var tool = providers[4].multiplexers.find(function (m) { return m.id === toolId; });
    if (tool.busy) return error('An operation is already running.', 'install_in_progress', 409);
    if (kind !== 'install' && !tool.installs.some(function (c) { return c.path === body.path; })) return error('Installation not found.', 'unknown_copy', 404);
    if (kind === 'install' && !tool.installable) return error('Already installed.', 'not_installable', 400);
    var id = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
    var made = session(id, 'shell', kind.charAt(0).toUpperCase() + kind.slice(1) + ' ' + toolId, 'demo', null, []);
    made.task = 'install'; made.reporting = null;
    tool.busy = true;
    transcripts[id] = 'Simulated ' + kind + ' of ' + toolId + '\r\nNo commands are run on your computer.\r\n';
    sessions.push(made);
    announce({ type: 'session.created', session: clone(made) });
    announce({ type: 'providers.updated', providers: clone(providers) });
    setTimeout(function () {
      tool.busy = false;
      tool.available = kind !== 'uninstall';
      tool.installable = !tool.available;
      tool.installs = tool.available ? [Object.assign(copy('brew', '/opt/homebrew/bin/' + toolId, true, 'brew uninstall ' + toolId, []), {
        version: toolId === 'herdr' ? (kind === 'install' ? '0.9.2' : '0.9.3') : (kind === 'install' ? '3.4' : '3.5'), supported: true,
        updateCommand: 'brew upgrade ' + toolId, updateAvailable: kind === 'install',
      })] : [];
      tool.lastInstall = { kind: kind, outcome: kind === 'uninstall' ? 'removed' : kind === 'install' ? 'installed' : 'updated', exitCode: 0 };
      made.status = 'exited'; made.exitCode = 0; made.activity = 'quiet';
      announce({ type: 'session.updated', session: clone(made) });
      announce({ type: 'providers.updated', providers: clone(providers) });
    }, 1000);
    return json({ session: clone(made) }, 201);
  }

  function uninstall(providerId, body) {
    var p = providers.find(function (item) { return item.id === providerId; });
    if (!p) return error('unknown provider "' + providerId + '"', 'unknown_provider', 404);
    if (typeof body.path !== 'string' || !body.path) return error('path must name the copy to remove', 'bad_request');
    var list = copies[p.id] || [];
    var c = list.find(function (item) { return item.path === body.path; });
    if (!c) return error(p.tool + ' has no copy at ' + body.path, 'unknown_copy', 404);
    var mine = function (s) { return s.status === 'running' && s.provider.id === p.id; };
    if (sessions.some(function (s) { return mine(s) && s.task === 'install'; })) {
      return error(p.tool + ' is already being installed, updated or removed', 'install_in_progress', 409);
    }
    var running = sessions.filter(function (s) { return mine(s) && s.task === null; }).length;
    if (running > 0 && body.force !== true) {
      return json({ error: { message: running + ' ' + p.tool + ' session(s) are running; removing the tool now may break them', code: 'provider_in_use', running: running } }, 409);
    }
    var id = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
    var made = session(id, p.id, 'Uninstall ' + p.tool + ' (' + labels[c.channel] + ')', 'demo', null, []);
    made.cwd = home; made.task = 'install'; made.reporting = null; made.toolSessionId = null;
    transcripts[id] = uninstallTranscript(c);
    sessions.push(made); announce({ type: 'session.created', session: clone(made) });
    setTimeout(function () {
      made.status = 'exited'; made.exitCode = 0; made.activity = 'quiet'; made.exitedAt = new Date().toISOString();
      list.splice(list.indexOf(c), 1);
      syncInstalls(p);
      p.lastInstall = { kind: 'uninstall', outcome: 'removed', exitCode: 0, at: Date.now() };
      announce({ type: 'session.updated', session: clone(made) });
      announce({ type: 'providers.updated', providers: clone(providers) });
    }, 1500);
    return json({ session: clone(made) }, 201);
  }

  function DemoWebSocket(url) {
    this.url = String(url); this.readyState = DemoWebSocket.CONNECTING; this.listeners = {};
    var self = this;
    setTimeout(function () {
      self.readyState = DemoWebSocket.OPEN; self.emit({ type: 'open' });
      if (/\/events(?:\?|$)/.test(self.url)) {
        eventSockets.push(self);
        self.emit({ data: JSON.stringify({ type: 'hello', version: version, pid: null, launcher: null, upgrade: null, sessions: clone(sessions) }) });
      } else {
        var match = self.url.match(/\/sessions\/([a-f0-9]+)\/terminal/);
        var current = match && sessions.find(function (item) { return item.id === match[1]; });
        if (!current) return self.close(4404, 'session not found');
        var text = transcripts[current.id] || '\u001b[1;36mAgent Guild interactive demo\u001b[0m\r\n\r\n' +
          '$ ' + current.name + '\r\n' +
          '\u001b[32m✓\u001b[0m Simulated session ready in ' + current.cwd + '\r\n' +
          '\u001b[2mNo command is running; input is echoed locally for demonstration.\u001b[0m\r\n\r\n> ';
        self.emit({ data: JSON.stringify({ type: 'snapshot', data: text, cols: 120, rows: 32, session: clone(current) }) });
      }
    }, 20);
  }
  DemoWebSocket.CONNECTING = 0; DemoWebSocket.OPEN = 1; DemoWebSocket.CLOSING = 2; DemoWebSocket.CLOSED = 3;
  DemoWebSocket.prototype.addEventListener = function (type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); };
  DemoWebSocket.prototype.removeEventListener = function (type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(function (item) { return item !== fn; }); };
  DemoWebSocket.prototype.emit = function (event) {
    var type = event.type || (Object.prototype.hasOwnProperty.call(event, 'data') ? 'message' : '');
    if (typeof this['on' + type] === 'function') this['on' + type](event);
    (this.listeners[type] || []).forEach(function (fn) { fn(event); });
  };
  DemoWebSocket.prototype.send = function (raw) {
    if (!/\/terminal/.test(this.url)) return;
    try {
      var message = JSON.parse(raw);
      if (message.type === 'input' && message.data && !/[\r\n]/.test(message.data)) this.emit({ data: JSON.stringify({ type: 'data', data: message.data }) });
      else if (message.type === 'input' && /[\r\n]/.test(message.data || '')) this.emit({ data: JSON.stringify({ type: 'data', data: '\r\n\u001b[2m[demo only — no command was executed]\u001b[0m\r\n> ' }) });
    } catch (_) { /* ignore malformed demo input */ }
  };
  DemoWebSocket.prototype.close = function (code, reason) {
    if (this.readyState === DemoWebSocket.CLOSED) return;
    this.readyState = DemoWebSocket.CLOSED;
    eventSockets = eventSockets.filter(function (item) { return item !== this; }, this);
    this.emit({ type: 'close', code: code || 1000, reason: reason || '' });
  };
  window.WebSocket = DemoWebSocket;

  try { localStorage.setItem('agentGuild.token', 'public-demo'); } catch (_) { /* storage may be blocked */ }
  var notice = document.createElement('aside');
  notice.className = 'demo-notice';
  notice.setAttribute('role', 'note');
  notice.innerHTML = '<strong>Interactive demo</strong> — sessions and usage are simulated; no CLI tools or commands are running. <a href="https://github.com/oddessentials/agent-guild#quick-start">Install Agent Guild</a>';
  document.body.prepend(notice);
  var style = document.createElement('style');
  // Like the page header, the notice sits below the terminal's compact touch view.
  style.textContent = '.demo-notice{position:relative;z-index:5;padding:.55rem 1rem;text-align:center;background:#312e81;color:#fff;font:600 14px/1.4 system-ui,sans-serif}.demo-notice a{color:#fff;text-decoration:underline}.demo-notice+header{position:sticky}';
  document.head.append(style);
}());
