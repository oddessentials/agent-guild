const STATES = { pending: 'Not checked', not_found: 'Not found', unavailable: 'Runtime unavailable', failed: 'Probe failed' };
const PIN_STATES = { configured: 'Configured', unreadable: 'Unreadable', invalid: 'Invalid' };
const SCOPES = [
  ['manager', 'Manager', 'Manager environment'],
  ['project', 'This project', 'Project pins'],
  ['session', 'Existing session', 'Session spawn environment'],
  ['launch', 'New shell', 'New shell launch PATH'],
];

export function runtimeValue(row) { return row.status === 'ok' ? row.version : STATES[row.status] || 'Probe failed'; }

export function createEnvironmentUI({
  api, onAuthError, isAuthError = () => false, document = globalThis.document,
  workingFolder = () => '', sessions = () => [],
} = {}) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('environment');
  let manager = null, current = null, scope = 'manager', request = 0, pending = false, online = false, managerPid = null, error = '', openerId = null;
  let projectFolder = '', visibleProject = '', sessionId = '';
  const slots = new Map();
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  function renderSummary(host) {
    const values = host.querySelector('.environment-values');
    const found = (manager?.runtimes || []).filter((row) => row.status === 'ok');
    values.replaceChildren(...found.flatMap((row) => [element('dt', row.label), element('dd', row.version)]));
    const note = host.querySelector('.environment-note');
    note.textContent = error && scope === 'manager' ? 'Environment check unavailable'
      : manager?.refreshing ? manager.checkedAt ? 'Refreshing · showing previous check' : 'Checking environment…'
        : manager?.error ? manager.error
          : !manager ? 'Not checked' : !found.length ? 'No runtime versions verified' : 'Manager environment';
  }

  function rowElement(row) {
    const node = element('section', undefined, 'environment-row');
    const head = element('div', undefined, 'environment-row-head');
    head.append(element('strong', row.label), element('span', runtimeValue(row)));
    node.append(head);
    if (row.command) node.append(element('p', `Command: ${row.command}`, 'environment-detail'));
    if (row.path) node.append(element('code', row.path, 'environment-path'));
    const detail = row.detail || (row.status === 'not_found' ? 'No executable was found on the manager’s PATH.' : '');
    if (detail) node.append(element('p', detail, 'environment-detail'));
    for (const alternate of row.alternatives || []) {
      node.append(element('p', `Also found: ${alternate.command} · ${runtimeValue(alternate)}`, 'environment-detail'));
      node.append(element('code', alternate.path, 'environment-path'));
      if (alternate.detail) node.append(element('p', alternate.detail, 'environment-detail'));
    }
    for (const runtime of row.runtimes || []) node.append(element('p', `${runtime.name} ${runtime.version}`, 'environment-detail'));
    return node;
  }

  function pinElement(row) {
    const node = element('section', undefined, 'environment-row');
    const head = element('div', undefined, 'environment-row-head');
    head.append(element('strong', row.label), element('span', PIN_STATES[row.status] || 'Invalid'));
    node.append(head);
    node.append(element('p', row.source, 'environment-detail'));
    if (row.version) node.append(element('code', row.version, 'environment-path'));
    if (row.detail) node.append(element('p', row.detail, 'environment-detail'));
    return node;
  }

  function showRuntimes(rows) {
    $('environment-runtimes').hidden = false;
    $('environment-runtimes').replaceChildren(...(rows || []).map(rowElement));
    $('environment-pins').hidden = true;
    $('environment-pins').replaceChildren();
  }

  function activeSnapshot() {
    if (scope === 'manager') return manager;
    const folder = workingFolder();
    if (scope === 'project') {
      if (!folder || folder !== projectFolder || !visibleProject || current?.cwd !== visibleProject) return null;
      return current?.scope === 'project' ? current : null;
    }
    return current?.scope === scope ? current : null;
  }

  function render() {
    for (const host of document.querySelectorAll('.environment-summary:not([hidden])')) renderSummary(host);
    const data = activeSnapshot();
    const title = SCOPES.find(([id]) => id === scope)?.[2] || 'Manager environment';
    $('environment-title').textContent = title;
    $('environment-host').textContent = data?.host || manager?.host ? `On ${data?.host || manager.host}` : 'On the computer running Agent Guild';
    for (const [id] of SCOPES) {
      const button = $(`environment-scope-${id}`);
      button.ariaPressed = String(id === scope);
    }
    const folder = workingFolder();
    const listed = sessions();
    $('environment-intro').textContent = scope === 'project'
      ? 'Configured versions in this folder. A pin is not proof the runtime is installed.'
      : scope === 'session'
        ? 'The PATH this manager passed to the session. Startup files that ran afterward are not included.'
        : scope === 'launch'
          ? 'A new session receives this PATH. The shell may then run its startup files.'
          : 'Versions available to the manager. Shell profiles, projects and existing sessions can use different versions.';
    $('environment-python-note').hidden = scope !== 'manager';
    $('environment-folder').hidden = scope !== 'project';
    $('environment-folder').textContent = folder ? `Folder: ${data?.cwd || folder}` : 'Choose a working folder.';
    $('environment-session-label').hidden = scope !== 'session';
    $('environment-session').hidden = scope !== 'session';
    if (scope === 'session') {
      const select = $('environment-session');
      const same = select.children.length === listed.length && listed.every((session, index) => select.children[index]?.value === session.id);
      if (!same) {
        select.replaceChildren(...listed.map((session) => {
          const option = element('option', `${session.name || session.tool || 'Session'} · ${session.cwd || 'unknown folder'}`);
          option.value = session.id;
          return option;
        }));
      }
      if (!listed.some((session) => session.id === sessionId)) sessionId = listed[0]?.id || '';
      select.value = sessionId;
    }
    const refreshing = Boolean(data?.refreshing);
    const blocked = scope === 'project' ? !folder : scope === 'session' ? !sessionId : false;
    $('environment-refresh').disabled = !online || pending || refreshing || blocked;
    $('environment-refresh').textContent = pending || refreshing ? 'Checking…' : 'Refresh';
    $('environment-status').textContent = error || (blocked && scope === 'project' ? 'Choose a working folder.'
      : blocked ? 'No sessions.'
        : scope === 'project' && folder !== projectFolder ? 'Refresh to read this folder.'
          : data?.refreshing ? data.checkedAt ? 'Refreshing. Previous results remain visible.' : scope === 'project' ? 'Reading pin files…' : 'Checking…'
            : data?.error ? data.error
              : data?.stale ? data.detail || 'These pins may be out of date. Refresh to read the folder again.'
                : data?.availability === 'unavailable' ? data.detail
                  : data?.checkedAt ? `Last checked ${new Date(data.checkedAt).toLocaleString()}`
                    : 'Not checked yet.');
    const tools = scope === 'project' || data?.availability === 'unavailable' ? [] : (data?.tools || []);
    const showTools = scope !== 'project' && data?.availability !== 'unavailable';
    $('environment-tools-heading').hidden = !showTools;
    $('environment-tools-note').hidden = !showTools;
    $('environment-tools').hidden = !showTools;
    $('environment-tools-empty').hidden = !showTools;
    if (scope === 'project' && data && folder === projectFolder) {
      $('environment-runtimes').hidden = true;
      $('environment-runtimes').replaceChildren();
      $('environment-pins').hidden = false;
      $('environment-pins').replaceChildren(...(data.pins.length ? data.pins.map(pinElement) : [element('p', data.refreshing ? 'Reading pin files…' : 'No version pins in this folder.', 'environment-detail')]));
    } else if (scope === 'session' && data?.availability === 'unavailable') {
      showRuntimes([]);
    } else if (data && (scope !== 'project' || folder === projectFolder)) {
      showRuntimes(data.runtimes);
    } else {
      showRuntimes([]);
    }
    if (showTools) {
      $('environment-tools').replaceChildren(...tools.map((tool) => {
        const node = element('section', undefined, 'environment-row');
        node.append(element('strong', `${tool.label} · Detected`), element('code', tool.path, 'environment-path'));
        return node;
      }));
      $('environment-tools-empty').hidden = Boolean(tools.length);
      $('environment-tools-empty').textContent = data?.refreshing ? 'Checking…' : data?.error ? 'Tool discovery did not finish.' : 'No supported tools detected.';
    }
    $('environment-manager-node').hidden = scope !== 'manager';
    $('environment-manager-node').textContent = scope === 'manager' && data?.managerNode
      ? `Agent Guild is running on Node.js ${data.managerNode.version} (${data.managerNode.path}).` : '';
    if (scope === 'session' && data?.availability === 'ok' && data.spawnCwd) {
      $('environment-manager-node').hidden = false;
      $('environment-manager-node').textContent = `Spawn folder: ${data.spawnCwd}`;
    }
    if (scope === 'launch' && data?.detail) {
      $('environment-manager-node').hidden = false;
      $('environment-manager-node').textContent = data.detail;
    }
  }

  function remember(snapshot) {
    if (!snapshot?.scope) return false;
    if (snapshot.scope === 'project') {
      const previous = slots.get(`project:${snapshot.cwd}`);
      if (previous && snapshot.revision < previous.revision) return false;
      slots.set(`project:${snapshot.cwd}`, snapshot);
      if (snapshot.cwd !== visibleProject) return false;
      current = snapshot;
      return true;
    }
    const previous = slots.get(snapshot.scope);
    if (previous && snapshot.revision < previous.revision) return false;
    slots.set(snapshot.scope, snapshot);
    if (snapshot.scope === 'manager') manager = snapshot;
    if (snapshot.scope === scope) current = snapshot;
    return true;
  }

  function updated(snapshot) {
    if (!online || !remember(snapshot)) return;
    error = '';
    render();
  }

  function requestFor(refresh) {
    if (scope === 'manager') return refresh ? ['POST', '/environment/refresh', {}] : ['GET', '/environment'];
    if (scope === 'project') {
      const cwd = workingFolder();
      if (cwd !== projectFolder) visibleProject = '';
      projectFolder = cwd;
      if (!cwd) return null;
      return refresh
        ? ['POST', '/environment/refresh', { scope: 'project', cwd }]
        : ['GET', `/environment?scope=project&cwd=${encodeURIComponent(cwd)}`];
    }
    if (scope === 'session') {
      if (!sessionId) return null;
      return refresh
        ? ['POST', '/environment/refresh', { scope: 'session', id: sessionId }]
        : ['GET', `/environment?scope=session&id=${encodeURIComponent(sessionId)}`];
    }
    return refresh ? ['POST', '/environment/refresh', { scope: 'launch' }] : ['GET', '/environment?scope=launch'];
  }

  async function load(refresh = false) {
    if (!online) return;
    const spec = requestFor(refresh);
    if (!spec) { error = ''; pending = false; render(); return; }
    const currentRequest = ++request;
    pending = true;
    error = '';
    render();
    try {
      const snapshot = await api(...spec);
      if (currentRequest !== request) return;
      if (snapshot?.scope === 'project') visibleProject = snapshot.cwd;
      updated(snapshot);
    } catch (err) {
      if (currentRequest !== request) return;
      if (isAuthError(err)) onAuthError?.(err.message);
      else error = err.message || 'Could not read this environment. Try Refresh.';
    } finally {
      if (currentRequest === request) { pending = false; render(); }
    }
  }

  function choose(next) {
    if (scope === next && next !== 'session') return;
    scope = next;
    current = slots.get(next) || null;
    error = '';
    if (next === 'session') {
      const listed = sessions();
      if (!listed.some((session) => session.id === sessionId)) sessionId = listed[0]?.id || '';
    }
    render();
    load(false);
  }

  for (const [id] of SCOPES) $(`environment-scope-${id}`).addEventListener('click', () => choose(id));
  $('environment-session').addEventListener('change', () => {
    sessionId = $('environment-session').value;
    current = null;
    load(false);
  });
  $('environment-close').addEventListener('click', () => dialog.close());
  $('environment-refresh').addEventListener('click', () => load(true));
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    // A queued close from an earlier opening must not clear the current opener.
    if (dialog.open) return;
    if (openerId) document.querySelector(`.provider[data-id="${openerId}"] .environment-open`)?.focus();
    openerId = null;
  });
  return {
    updated,
    connected(pid) {
      if (pid !== managerPid) {
        manager = null; current = null; slots.clear(); managerPid = pid; scope = 'manager';
        visibleProject = ''; projectFolder = ''; sessionId = '';
      }
      request++; pending = false; online = true; error = '';
      load();
    },
    disconnected() {
      request++; pending = false; online = false;
      error = 'Disconnected. Results are from the last check.';
      render();
    },
    close() { openerId = null; dialog.close(); this.disconnected(); },
    sync() { render(); },
    renderCard(card, provider) {
      const host = card.querySelector('.environment-summary');
      host.hidden = !Array.isArray(provider.shells);
      if (host.hidden) return;
      const button = host.querySelector('.environment-open');
      button.dataset.muxFocus = `${provider.id}:environment`;
      button.addEventListener('click', () => {
        openerId = provider.id;
        scope = 'manager';
        current = manager;
        error = '';
        render();
        if (!dialog.open) dialog.showModal();
      });
      renderSummary(host);
    },
  };
}
