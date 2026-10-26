// The page inside a host that cannot open windows: the VS Code extension frames it, the
// Agent Guild app for Apple devices shows it in a WKWebView with an `agentGuild` message handler,
// and the Android app shows it in a WebView with an `agentGuild` web message listener.
// Links go to the host as messages. Without a host, the page behaves exactly as before.

export const framed = typeof window !== 'undefined' && window.parent !== window;
const app = typeof window !== 'undefined' && !framed ? appHost() : null;
const hosted = framed || Boolean(app);
export const compact = hosted && document.documentElement?.dataset.layout === 'compact';
const expandable = hosted && document.documentElement?.dataset.expand !== 'none';
export const yardOff = hosted && document.documentElement?.dataset.yard === 'none';

/** The app's message channel, or null. */
function appHost() {
  const apple = window.webkit?.messageHandlers?.agentGuild;
  if (apple) return (message) => apple.postMessage(message);
  // Android's listener object carries strings only.
  const android = window.agentGuild;
  if (typeof android?.postMessage === 'function') return (message) => android.postMessage(JSON.stringify(message));
  return null;
}

function post(message) {
  // The manager's frame-ancestors lets only VS Code webviews frame the page.
  if (framed) window.parent.postMessage({ source: 'agent-guild', ...message }, '*');
  else app({ source: 'agent-guild', ...message });
}

/** The absolute http(s) URL `href` names, or null. */
export function webUrl(href) {
  try {
    const url = new URL(href, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

/** Open a link outside the page: a new tab, or through the host. */
export function openLink(href) {
  if (!hosted) {
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }
  const url = webUrl(href);
  if (url) post({ type: 'open', url });
}

/** Tell the host the page reached the manager. */
export function announceReady(version) {
  if (hosted) post({ type: 'ready', version });
}

export function expand(session) {
  if (expandable) post(session ? { type: 'expand', session } : { type: 'expand' });
}

let showView = null;
let showSession = null;

export function onViewRequest(callback) {
  showView = callback;
}

export function onSessionRequest(callback) {
  showSession = callback;
}

if (hosted) {
  // The app posts its request into the page itself, so a subframe such as the video player cannot pass for it.
  const [sender, expected] = framed ? [window.parent, 'agent-guild-vscode'] : [window, 'agent-guild-app'];
  window.addEventListener('message', (event) => {
    if (event.source !== sender || (app && event.origin !== location.origin)) return;
    const { source, type, view, id } = event.data ?? {};
    if (source !== expected) return;
    if (type === 'view' && (view === 'cards' || (view === 'yard' && !yardOff))) showView?.(view);
    if (type === 'session' && typeof id === 'string') showSession?.(id);
  });
  if (framed && !compact) {
    const root = document.documentElement;
    const look = () => post({ type: 'look', skin: root.dataset.skin, theme: root.dataset.theme });
    new MutationObserver(look).observe(root, { attributes: true, attributeFilter: ['data-skin', 'data-theme'] });
    look();
  }
  const follow = (event) => {
    if (event.button > 1) return;
    const link = event.target.closest?.('a[target="_blank"][href]');
    if (!link) return;
    event.preventDefault();
    openLink(link.href);
  };
  document.addEventListener('click', follow, true);
  document.addEventListener('auxclick', follow, true);
}

/**
 * Copy text. A framed page is refused navigator.clipboard.writeText even on a click,
 * while execCommand('copy') still works, so that is the fallback.
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    if (!copyWithSelection(text)) throw err;
  }
}

function copyWithSelection(text) {
  const active = document.activeElement;
  const range = typeof active?.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  // A modal dialog makes everything outside it inert, so the textarea goes inside the topmost one.
  const host = [...document.querySelectorAll('dialog')].filter((d) => d.matches(':modal')).pop() ?? document.body;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
  host.append(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { /* reported as not copied */ }
  area.remove();
  active?.focus?.({ preventScroll: true });
  if (range) try { active.setSelectionRange(...range); } catch { /* not a text field any more */ }
  return copied;
}
