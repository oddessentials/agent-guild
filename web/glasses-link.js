import { paintQr } from './remote-access.js';

export function glassesInstallLink(address, token) {
  const page = new URL('/glasses.html', address);
  page.hash = new URLSearchParams({ token }).toString();
  return `fb-viewapp://web_app_deep_link?appName=${encodeURIComponent('Agent Guild')}&appUrl=${encodeURIComponent(page.href)}`;
}

/** The manager's allowed HTTPS origins: the one this page is open on first, then Tailscale's, then the rest. */
export function glassesAddresses({ url = null, origins = [] }, pageOrigin) {
  const allowed = new Set(origins);
  return [...new Set([pageOrigin, url && new URL(url).origin, ...origins])]
    .filter((origin) => origin?.startsWith('https://') && allowed.has(origin));
}

export function createGlassesLinkUI({ api, getToken, isConnected, onAuthError }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('glasses');
  let generation = 0, qrcode = null;

  function clear() {
    generation++;
    $('glasses-code').hidden = true;
    $('glasses-show').setAttribute('aria-expanded', 'false');
    $('glasses-note').textContent = '';
    $('glasses-address-row').hidden = true;
    $('glasses-address').replaceChildren();
    const canvas = $('glasses-qr');
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
  }

  function paint() {
    paintQr($('glasses-qr'), qrcode, glassesInstallLink($('glasses-address').value, getToken()));
  }

  async function toggle() {
    if (!$('glasses-code').hidden) return clear();
    if (!getToken() || !isConnected()) return;
    const run = ++generation;
    $('glasses-code').hidden = false;
    $('glasses-show').setAttribute('aria-expanded', 'true');
    $('glasses-note').textContent = 'Preparing the code…';
    try {
      const { remoteAccess } = await api('GET', '/remote-access');
      if (run !== generation || !dialog.open) return;
      const addresses = glassesAddresses(remoteAccess, location.origin);
      if (!addresses.length) {
        $('glasses-note').textContent = 'The glasses need an HTTPS address. Set one up in Settings, Remote access.';
        return;
      }
      qrcode ??= (await import('./vendor/qrcode.mjs')).default;
      if (run !== generation || !dialog.open) return;
      $('glasses-address').replaceChildren(...addresses.map((address) => new Option(address, address)));
      $('glasses-address-row').hidden = addresses.length < 2;
      paint();
      $('glasses-note').textContent = '';
    } catch (error) {
      if (run !== generation) return;
      if (error.name === 'AuthError' || error.message === 'The access token was rejected.') { close(); onAuthError(error.message); return; }
      $('glasses-note').textContent = error.message || 'The code could not load. Try again.';
    }
  }

  function close() {
    clear();
    if (dialog.open) dialog.close();
  }

  $('glasses-open').addEventListener('click', () => {
    $('settings-menu').hidePopover?.();
    $('topbar-menu').hidePopover?.();
    clear();
    if (!dialog.open) dialog.showModal();
  });
  $('glasses-close').addEventListener('click', close);
  $('glasses-show').addEventListener('click', toggle);
  $('glasses-address').addEventListener('change', () => { if (qrcode && !$('glasses-qr').hidden) paint(); });
  dialog.addEventListener('close', () => { clear(); ($('settings').checkVisibility() ? $('settings') : $('menu-toggle')).focus(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') clear(); });
  return {
    setAvailable(capability) { $('glasses-open').hidden = !capability?.available; if (!capability?.available) close(); },
    connectionChanged() { if (!isConnected()) close(); },
    close,
  };
}
