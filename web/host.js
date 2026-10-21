// The page inside an editor tab: the Agent Guild VS Code extension frames it.
// The frame cannot open windows, so links go to the extension as messages.
// Unframed, the page behaves exactly as before.

export const framed = typeof window !== 'undefined' && window.parent !== window;

function post(message) {
  // The manager's frame-ancestors lets only VS Code webviews frame the page.
  window.parent.postMessage({ source: 'agent-guild', ...message }, '*');
}

/** The absolute http(s) URL `href` names, or null. */
export function webUrl(href) {
  try {
    const url = new URL(href, location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

/** Open a link outside the page: a new tab, or through the extension when framed. */
export function openLink(href) {
  if (!framed) {
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }
  const url = webUrl(href);
  if (url) post({ type: 'open', url });
}

/** Tell the extension the page reached the manager. */
export function announceReady(version) {
  if (framed) post({ type: 'ready', version });
}

let showView = null;

export function onViewRequest(callback) {
  showView = callback;
}

if (framed) {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const { source, type, view } = event.data ?? {};
    if (source === 'agent-guild-vscode' && type === 'view' && (view === 'cards' || view === 'yard')) showView?.(view);
  });
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
