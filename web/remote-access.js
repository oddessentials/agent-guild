export function remotePresentation(data) {
  if (!data) return { title: 'Checking connection…', text: 'Looking for Tailscale on this computer.', label: 'Enable remote access' };
  const problem = data.problem;
  if (data.busy && problem?.code !== 'approval_required') return {
    title: data.busy === 'checking' ? 'Checking connection…' : data.busy === 'disabling' ? 'Disabling remote access…' : 'Preparing remote access…',
    text: 'Your terminal sessions keep running.', label: 'Please wait…',
  };
  if (data.pending === 'disable') return { title: 'Tailscale cleanup needed', text: problem?.code === 'permission_required'
    ? 'Remote access is blocked. Run the cleanup command in Connection details from a terminal with permission to manage Tailscale, then retry cleanup.'
    : problem?.message || 'Access through the saved address is blocked. Retry to remove its Serve route.', label: 'Retry cleanup', action: 'disable',
    ...(['not_installed', 'update_required'].includes(problem?.code) ? { help: 'https://tailscale.com/download', helpLabel: 'Get Tailscale' } : {}) };
  if (problem?.approvalUrl) return { title: 'One step needed in Tailscale', text: problem.message, help: problem.approvalUrl, helpLabel: 'Open Tailscale approval', label: 'Continue setup' };
  if (problem?.code === 'not_installed') return { title: 'Connect this computer to Tailscale', text: problem.message, help: 'https://tailscale.com/download', helpLabel: 'Install Tailscale', label: 'Continue setup' };
  if (problem?.code === 'update_required') return { title: 'Update Tailscale', text: problem.message, help: 'https://tailscale.com/download', helpLabel: 'Get Tailscale', label: 'Continue setup' };
  if (problem?.code === 'not_connected' || problem?.code === 'address_unavailable') return { title: 'Connect Tailscale', text: problem.message, label: 'Continue setup' };
  if (problem?.code === 'permission_required') return { title: 'Tailscale needs permission', text: 'Open a terminal on this computer with permission to manage Tailscale. The connection details below show the command to run, then choose Continue setup.', label: 'Continue setup' };
  if (problem) return { title: data.pending === 'enable' ? 'Finish setting up remote access' : 'Connection needs attention', text: problem.message, label: data.mode === 'tailscale' ? 'Repair connection' : data.candidate?.existing ? 'Use existing route' : 'Continue setup' };
  if (data.mode === 'tailscale') return {
    title: 'Remote access enabled', text: data.connection?.ok ? 'The secure address reaches this manager. Connect another device to start using it.'
      : data.connection ? 'The route is configured, but this computer could not verify the secure connection. Check Tailscale, then try the address on your other device.' : 'Your saved Tailscale address is ready to check.',
    label: 'Repair connection', hidePrimary: true,
  };
  if (data.candidate?.existing) return { title: 'Your Tailscale route is ready', text: 'A private route already points to this manager. Use it to let Agent Guild save and manage this connection.', label: 'Use existing route' };
  if (data.mode === 'custom') return { title: 'Custom proxy access configured', text: data.source === 'environment' ? 'These settings came from the launch environment. Save them below to keep them across launches.' : 'Your proxy settings are saved and active.', label: 'Set up Tailscale' };
  if (!data.tailscale) return { title: 'Set up remote access', text: 'Check this computer’s Tailscale connection to get started.', label: 'Enable remote access' };
  return { title: 'Tailscale connected', text: 'Enable a private address for your running terminals. Your settings will be saved for future launches.', label: 'Enable remote access' };
}

/**
 * The link another device signs in with: the phone view at the remote address,
 * with the token in the fragment, which browsers never send to the server. The
 * full page is one tap away from there, and the token carries over.
 */
export function signInLink(address, token) {
  const url = new URL(address);
  url.pathname = '/mobile/';
  url.search = '';
  url.hash = new URLSearchParams({ token }).toString();
  return url.href;
}

export function createRemoteAccessUI({ api, getToken, isConnected, onAuthError }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('remote-access');
  let data = null, request = 0, loading = false, posting = false, timer = null, sharing = false, shareGeneration = 0, editRevision = null, dirty = false;
  let available = false, waitingForApproval = false;

  function clearShare() {
    sharing = false;
    shareGeneration++;
    $('remote-share').hidden = true;
    $('remote-connect').setAttribute('aria-expanded', 'false');
    $('remote-signin').value = '';
    const canvas = $('remote-qr');
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
  }

  function render() {
    const presentation = remotePresentation(data);
    const busy = loading || posting || Boolean(data?.busy) || !isConnected();
    $('remote-status-title').textContent = presentation.title;
    $('remote-status-text').textContent = isConnected() ? presentation.text : 'Reconnect to the manager to change remote access.';
    $('remote-status-title').parentElement.dataset.ready = String(data?.mode === 'tailscale' && !data.problem && !data.busy && Boolean(data.connection?.ok));
    $('remote-primary').textContent = presentation.label;
    $('remote-primary').hidden = Boolean(presentation.hidePrimary || (presentation.help && !presentation.action));
    $('remote-primary').disabled = busy || !data;
    $('remote-check').disabled = busy || !data;
    $('remote-disable').disabled = busy || !data;
    $('remote-disable').hidden = !data || (data.mode === 'off' && !data.pending);
    $('remote-disable-yes').disabled = busy;
    $('remote-custom-save').disabled = busy || !data || data.mode === 'tailscale' || Boolean(data.pending);
    for (const id of ['remote-hosts', 'remote-origins']) $(id).disabled = !data || data.mode === 'tailscale' || Boolean(data.pending);
    $('remote-custom-note').textContent = data?.mode === 'tailscale' || data?.pending
      ? 'Disable Tailscale remote access and finish any cleanup before switching to another proxy.'
      : 'Configure your proxy separately, then enter the hosts and browser origins it uses. Saving applies immediately and replaces environment settings.';
    $('remote-help').hidden = !presentation.help;
    if (presentation.help) { $('remote-help').href = presentation.help; $('remote-help').textContent = presentation.helpLabel; }
    $('remote-address-row').hidden = !data?.url;
    $('remote-address').value = data?.url || '';
    $('remote-open-address').href = data?.url || '#';
    $('remote-connect').disabled = busy;
    $('remote-copy-address').disabled = busy;
    $('remote-copy-signin').disabled = busy;
    if (!data?.url || !isConnected() || data.busy === 'disabling') clearShare();
    $('remote-forget').hidden = data?.pending !== 'disable' || !['route_changed', 'network_changed'].includes(data.problem?.code);
    $('remote-forget').disabled = busy;
    const diagnostics = [data?.tailscale ? `Tailscale ${data.tailscale.version} · ${data.tailscale.hostname}` : '',
      data?.source === 'saved' ? 'Settings are saved on the manager computer.' : data?.source === 'environment' ? 'Settings currently come from the launch environment.' : '',
      data?.connection?.checkedAt ? `Last connection check: ${new Date(data.connection.checkedAt).toLocaleString()}` : '',
      data?.command ? `On the manager computer: ${data.command}` : '',
    ].filter(Boolean);
    $('remote-diagnostics').textContent = diagnostics.join('\n');
    if (data && !dirty) {
      $('remote-hosts').value = data.hosts.join(', ');
      $('remote-origins').value = data.origins.join(', ');
      editRevision = data.revision;
    }
    if (data?.problem?.approvalUrl) waitingForApproval = true;
  }

  function showError(error) {
    if (error.name === 'AuthError' || error.message === 'The access token was rejected.') { close(); onAuthError(error.message); return; }
    $('remote-error').textContent = error.message || 'Could not change remote access. Try again.';
    $('remote-error').hidden = false;
  }

  function schedule() {
    clearTimeout(timer);
    if (dialog.open && available && isConnected()) timer = setTimeout(() => refresh(!data?.busy), data?.busy ? 800 : 30000);
  }

  async function refresh(check = false) {
    if (!dialog.open || !available || !isConnected() || loading || posting) return;
    const generation = ++request;
    loading = true;
    if (check) $('remote-error').hidden = true;
    render();
    try {
      const result = await api(check ? 'POST' : 'GET', check ? '/remote-access/check' : '/remote-access');
      if (generation !== request || !dialog.open) return;
      if (data?.url !== result.remoteAccess.url) clearShare();
      data = result.remoteAccess;
    } catch (error) { if (generation === request && dialog.open) showError(error); }
    finally { if (generation === request) { loading = false; render(); schedule(); } }
    if (waitingForApproval && !data?.busy && data?.pending === 'enable' && data?.tailscale?.httpsReady && dialog.open) {
      waitingForApproval = false;
      await change('enable');
    }
  }

  async function change(action, extra = {}) {
    if (!data || posting || data.busy || !isConnected()) return;
    posting = true;
    const generation = ++request;
    $('remote-error').hidden = true;
    $('remote-disable-confirm').hidden = true;
    if (action !== 'enable') clearShare();
    render();
    try {
      const result = await api('PUT', '/remote-access', { revision: data.revision, action, adopt: Boolean(data.candidate?.existing), ...extra });
      if (generation !== request || !dialog.open) return;
      data = result.remoteAccess;
      if (action === 'custom') dirty = false;
    } catch (error) {
      if (generation === request && dialog.open) {
        showError(error);
        if (error.code === 'stale_settings') {
          dirty = false;
          try { data = (await api('GET', '/remote-access')).remoteAccess; } catch (refreshError) { showError(refreshError); }
        }
      }
    } finally { if (generation === request) { posting = false; render(); schedule(); } }
  }

  async function copy(input, button) {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(input.value);
      const label = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = label; }, 1600);
    } catch {
      input.focus(); input.select();
      $('remote-error').textContent = 'The link is selected. Use your browser’s Copy command.';
      $('remote-error').hidden = false;
    }
  }

  async function toggleShare() {
    if (sharing) { clearShare(); return; }
    if (!data?.url || !getToken() || !isConnected()) return;
    sharing = true;
    const generation = ++shareGeneration;
    const url = new URL(signInLink(data.url, getToken()));
    $('remote-signin').value = url.href;
    $('remote-share').hidden = false;
    $('remote-connect').setAttribute('aria-expanded', 'true');
    $('remote-qr-note').textContent = 'Preparing QR code…';
    try {
      const { default: qrcode } = await import('./vendor/qrcode.mjs');
      if (!sharing || generation !== shareGeneration || !dialog.open) return;
      const code = qrcode(0, 'M');
      code.addData(url.href, 'Byte');
      code.make();
      const count = code.getModuleCount(), scale = 5, border = 4;
      const canvas = $('remote-qr');
      canvas.width = canvas.height = (count + border * 2) * scale;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#000000';
      for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
        if (code.isDark(row, col)) context.fillRect((col + border) * scale, (row + border) * scale, scale, scale);
      }
      canvas.hidden = false;
      $('remote-qr-note').textContent = '';
    } catch { if (generation === shareGeneration) $('remote-qr-note').textContent = 'The QR code could not load. Use the sign-in link below.'; }
  }

  function close() {
    request++; loading = false; posting = false;
    clearTimeout(timer); clearShare();
    $('remote-disable-confirm').hidden = true;
    if (dialog.open) dialog.close();
  }

  $('remote-access-open').addEventListener('click', async () => {
    $('settings-menu').hidePopover?.();
    $('topbar-menu').hidePopover?.();
    if (!dialog.open) dialog.showModal();
    $('remote-error').hidden = true;
    dirty = false;
    await refresh(false);
    await refresh(true);
  });
  $('remote-close').addEventListener('click', close);
  dialog.addEventListener('click', (event) => { if (event.target === dialog && event.clientX !== 0) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  } });
  dialog.addEventListener('close', () => { close(); ($('settings').checkVisibility() ? $('settings') : $('menu-toggle')).focus(); });
  $('remote-primary').addEventListener('click', () => change(remotePresentation(data).action || 'enable'));
  $('remote-check').addEventListener('click', () => refresh(true));
  $('remote-disable').addEventListener('click', () => { $('remote-disable-confirm').hidden = false; $('remote-disable-yes').focus(); });
  $('remote-disable-yes').addEventListener('click', () => change('disable'));
  $('remote-disable-no').addEventListener('click', () => { $('remote-disable-confirm').hidden = true; $('remote-disable').focus(); });
  $('remote-forget').addEventListener('click', () => change('forget'));
  $('remote-connect').addEventListener('click', toggleShare);
  $('remote-copy-address').addEventListener('click', () => copy($('remote-address'), $('remote-copy-address')));
  $('remote-copy-signin').addEventListener('click', () => copy($('remote-signin'), $('remote-copy-signin')));
  for (const id of ['remote-hosts', 'remote-origins']) $(id).addEventListener('input', () => { dirty = true; });
  $('remote-custom-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const list = (id) => $(id).value.split(',').map((value) => value.trim()).filter(Boolean);
    change('custom', { revision: editRevision, hosts: list('remote-hosts'), origins: list('remote-origins') });
  });
  addEventListener('focus', () => { if (dialog.open && !data?.busy) refresh(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clearShare();
    else if (dialog.open && !data?.busy) refresh(true);
  });
  return {
    setAvailable(capability) { available = Boolean(capability?.available); $('remote-access-open').hidden = !available; if (!available) close(); },
    updated() { if (dialog.open) refresh(false); },
    connectionChanged() { render(); if (!isConnected()) { clearTimeout(timer); clearShare(); } else schedule(); },
    close,
  };
}
