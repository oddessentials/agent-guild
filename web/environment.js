const STATES = { pending: 'Not checked', not_found: 'Not found', unavailable: 'Runtime unavailable', failed: 'Probe failed' };

export function runtimeValue(row) { return row.status === 'ok' ? row.version : STATES[row.status] || 'Probe failed'; }

export function createEnvironmentUI({ api, onAuthError, isAuthError = () => false, document = globalThis.document }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('environment');
  let data = null, request = 0, pending = false, online = false, managerPid = null, error = '', openerId = null;
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };

  function renderSummary(host) {
    const values = host.querySelector('.environment-values');
    const found = (data?.runtimes || []).filter((row) => row.status === 'ok');
    values.replaceChildren(...found.flatMap((row) => [element('dt', row.label), element('dd', row.version)]));
    const note = host.querySelector('.environment-note');
    note.textContent = error ? 'Environment check unavailable'
      : data?.refreshing ? data.checkedAt ? 'Refreshing · showing previous check' : 'Checking environment…'
        : data?.error ? data.error
          : !data ? 'Not checked' : !found.length ? 'No runtime versions verified' : 'Manager environment';
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

  function render() {
    for (const host of document.querySelectorAll('.environment-summary:not([hidden])')) renderSummary(host);
    $('environment-refresh').disabled = !online || pending || Boolean(data?.refreshing);
    $('environment-refresh').textContent = pending || data?.refreshing ? 'Checking…' : 'Refresh';
    $('environment-status').textContent = error || (data?.refreshing
      ? data.checkedAt ? 'Refreshing. Previous results remain visible.' : 'Checking the manager environment…'
      : data?.error || (data?.checkedAt ? `Last checked ${new Date(data.checkedAt).toLocaleString()}` : 'Not checked yet.'));
    $('environment-runtimes').replaceChildren(...(data?.runtimes || []).map(rowElement));
    const tools = data?.tools || [];
    $('environment-tools').replaceChildren(...tools.map((tool) => {
      const node = element('section', undefined, 'environment-row');
      node.append(element('strong', `${tool.label} · Detected`), element('code', tool.path, 'environment-path'));
      return node;
    }));
    $('environment-tools-empty').hidden = Boolean(tools.length);
    $('environment-tools-empty').textContent = data?.refreshing ? 'Checking…' : data?.error ? 'Tool discovery did not finish.' : 'No supported tools detected.';
    $('environment-manager-node').textContent = data?.managerNode
      ? `Agent Guild is running on Node.js ${data.managerNode.version} (${data.managerNode.path}).` : '';
  }

  function updated(snapshot) {
    if (!online || !snapshot || snapshot.scope !== 'manager') return;
    if (data && snapshot.revision < data.revision) return;
    data = snapshot;
    error = '';
    render();
  }

  async function load(refresh = false) {
    if (!online || pending) return;
    const current = ++request;
    pending = true;
    error = '';
    render();
    try {
      const snapshot = await api(refresh ? 'POST' : 'GET', refresh ? '/environment/refresh' : '/environment', refresh ? {} : undefined);
      if (current === request) updated(snapshot);
    } catch (err) {
      if (current !== request) return;
      if (isAuthError(err)) onAuthError?.(err.message);
      else error = 'Could not read the manager environment. Try Refresh.';
    } finally {
      if (current === request) { pending = false; render(); }
    }
  }

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
      if (pid !== managerPid) { data = null; managerPid = pid; }
      request++; pending = false; online = true;
      load();
    },
    disconnected() {
      request++; pending = false; online = false;
      error = 'Disconnected. Results are from the last check.';
      render();
    },
    close() { openerId = null; dialog.close(); this.disconnected(); },
    renderCard(card, provider) {
      const host = card.querySelector('.environment-summary');
      host.hidden = !Array.isArray(provider.shells);
      if (host.hidden) return;
      const button = host.querySelector('.environment-open');
      button.dataset.muxFocus = `${provider.id}:environment`;
      button.addEventListener('click', () => {
        openerId = provider.id;
        render();
        if (!dialog.open) dialog.showModal();
      });
      renderSummary(host);
    },
  };
}
