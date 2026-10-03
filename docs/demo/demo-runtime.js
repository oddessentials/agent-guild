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

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function json(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
  }
  function error(message, code, status) { return json({ error: { message: message, code: code } }, status || 400); }
  function announce(message) {
    eventSockets.forEach(function (socket) { socket.emit({ data: JSON.stringify(message) }); });
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.includes('/api/v1/')) return realFetch(input, init);
    var route = url.pathname.slice(url.pathname.indexOf('/api/v1/') + 7);
    var method = (init && init.method || 'GET').toUpperCase();
    var body = init && init.body ? JSON.parse(init.body) : {};

    if (route === '/providers' && method === 'GET') return json({ providers: clone(providers) });
    if (route === '/usage' && method === 'GET') return json({ usage: [
      { providerId: 'anthropic', accountId: 'default', signedIn: true, plan: 'pro', windows: [{ label: '5 hours', usedPercent: 36, resetsAt: new Date(now + 2 * 3600000).toISOString() }] },
      { providerId: 'anthropic', accountId: 'work', signedIn: true, plan: 'team', windows: [{ label: '5 hours', usedPercent: 18, resetsAt: new Date(now + 3 * 3600000).toISOString() }] },
      { providerId: 'openai', accountId: 'default', signedIn: true, plan: 'plus', windows: [{ label: 'Weekly', usedPercent: 43, resetsAt: new Date(now + 3 * 86400000).toISOString() }] },
    ] });
    if (route === '/model-stats' && method === 'GET') return json({ providers: {}, models: {}, retrievedAt: new Date(now).toISOString(), stale: false, error: null });
    if (route === '/news' && method === 'GET') return json({ refreshing: false, updatedAt: new Date(now).toISOString(), items: [
      { id: 'demo-news', title: 'Agent Guild interactive demo', url: 'https://github.com/oddessentials/agent-guild', source: 'Agent Guild', kind: 'news', publishedAt: new Date(now - 3600000).toISOString(), summary: 'Explore the interface with simulated local sessions.' },
    ], sources: [] });
    if (route === '/changelog' && method === 'GET') return json({ refreshing: false, releases: [], okAt: new Date(now).toISOString(), error: null });
    if (route === '/github' && method === 'GET') return json({ github: { accounts: [], signIn: null, git: { available: false }, ssh: { available: false } } });
    if (/^\/providers\/[^/]+\/history$/.test(route) && method === 'GET') return json({ history: [] });
    if (route === '/sessions' && method === 'POST') {
      var id = Math.random().toString(16).slice(2, 10).padEnd(8, '0');
      var p = providers.find(function (item) { return item.id === body.providerId; }) || providers[4];
      var made = session(id, p.id, body.name || p.tool + ' demo', String(body.cwd || 'demo').replace(/^.*[\\/]/, ''), p.id === 'shell' ? null : 'Demo model', []);
      sessions.push(made); announce({ type: 'session.created', session: clone(made) });
      return json({ session: clone(made) }, 201);
    }
    var match = route.match(/^\/sessions\/([a-f0-9]+)(?:\/(stop))?$/);
    if (match) {
      var at = sessions.findIndex(function (item) { return item.id === match[1]; });
      if (at < 0) return error('demo session not found', 'not_found', 404);
      if (method === 'PATCH') { sessions[at].name = String(body.name || sessions[at].name); announce({ type: 'session.updated', session: clone(sessions[at]) }); return json({ session: clone(sessions[at]) }); }
      if (method === 'POST' && match[2] === 'stop') { sessions[at].status = 'exited'; sessions[at].activity = 'quiet'; sessions[at].exitedAt = new Date().toISOString(); announce({ type: 'session.updated', session: clone(sessions[at]) }); return json({ session: clone(sessions[at]) }); }
      if (method === 'DELETE') { sessions.splice(at, 1); announce({ type: 'session.removed', id: match[1] }); return json({}); }
    }
    return error('This action is unavailable in the simulated demo.', 'demo_only', 409);
  };

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
        var text = '\u001b[1;36mAgent Guild interactive demo\u001b[0m\r\n\r\n' +
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
  style.textContent = '.demo-notice{position:relative;z-index:30;padding:.55rem 1rem;text-align:center;background:#312e81;color:#fff;font:600 14px/1.4 system-ui,sans-serif}.demo-notice a{color:#fff;text-decoration:underline}.demo-notice+header{position:sticky}';
  document.head.append(style);
}());

