import { bindVisibleViewport, onTouchTyping } from './layout.js';

const ARROWS = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };

/** Use the same cursor mode as a physical keyboard, including inside full-screen tools. */
export function terminalKey(key, modes) {
  if (Object.hasOwn(ARROWS, key)) return `\x1b${modes.applicationCursorKeysMode ? 'O' : '['}${ARROWS[key]}`;
  if (key === 'Enter') return '\r';
  if (key === 'Escape') return '\x1b';
  return null;
}

const sameTarget = (a, b) => Boolean(a && b && a.term === b.term && a.socket === b.socket && a.run === b.run);

/** Seven ordinary buttons. A gesture belongs to the session and connection where it began. */
export class TerminalControls {
  constructor({ element, panel, getCurrent, notify }) {
    this.element = element;
    this.getCurrent = getCurrent;
    this.notify = notify;
    this.buttons = [...element.querySelectorAll('button')];
    for (const button of this.buttons) {
      button.addEventListener('pointerdown', (event) => {
        this.cancel();
        if (!event.isPrimary || event.button !== 0 || button.disabled) return;
        // Retain xterm's focus if typing, and leave the keyboard closed if it is closed.
        event.preventDefault();
        const target = this.current();
        if (!target) return;
        this.press = { button, target, pointer: event.pointerId };
        this.gesture = event.pointerId;
        button.setPointerCapture(event.pointerId);
        button.classList.add('pressed');
      });
      button.addEventListener('pointermove', (event) => {
        if (this.press?.pointer === event.pointerId && document.elementFromPoint(event.clientX, event.clientY) !== button) this.cancel();
      });
      button.addEventListener('pointerup', (event) => {
        const press = this.press;
        if (press?.pointer !== event.pointerId) return;
        this.cancel();
        if (document.elementFromPoint(event.clientX, event.clientY) === button) this.activate(button, press.target);
      });
      for (const type of ['pointercancel', 'lostpointercapture', 'blur']) button.addEventListener(type, () => this.cancel());
      button.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (event.repeat) return;
        this.cancel();
        this.press = { button, target: this.current(), key: event.key };
        button.classList.add('pressed');
      });
      button.addEventListener('keyup', (event) => {
        const press = this.press;
        if (!press || press.key !== event.key || press.button !== button) return;
        event.preventDefault();
        this.cancel();
        this.activate(button, press.target);
      });
      // Pointer and keyboard releases were handled above. Keep assistive-technology
      // activation working without sending a second key for the following click.
      button.addEventListener('click', (event) => {
        if (event.detail === 0 && !event.pointerType) this.activate(button, this.current());
      });
    }
    // A key held while the terminals hide must not, on release, tap whatever now lies under the finger.
    addEventListener('pointerdown', () => { this.gesture = null; }, true);
    addEventListener('click', (event) => {
      if (this.gesture == null || event.pointerId !== this.gesture || this.element.contains(event.target)) return;
      this.gesture = null;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    addEventListener('blur', () => this.cancel());
    addEventListener('pagehide', () => this.cancel());
    document.addEventListener('visibilitychange', () => { this.cancel(); this.refresh(); });
    // Modal Copy (and other dialogs) must cancel a press even if it closes before release.
    new MutationObserver(() => { this.cancel(); this.refresh(); }).observe(document.body, {
      subtree: true, attributes: true, attributeFilter: ['open'],
    });
    new MutationObserver(() => this.refresh()).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    onTouchTyping((touch) => { element.hidden = !touch; this.refresh(); });
  }

  current() {
    if (this.element.hidden || document.visibilityState !== 'visible' || document.querySelector('dialog[open]')) return null;
    return this.getCurrent();
  }

  refresh() {
    const target = this.current();
    if (!sameTarget(this.press?.target, target)) this.cancel();
    for (const button of this.buttons) button.disabled = !target;
    this.element.setAttribute('aria-label', target ? `Terminal keys for ${target.name}` : 'Terminal keys unavailable');
  }

  cancel() {
    this.press?.button.classList.remove('pressed');
    this.press = null;
  }

  activate(button, target) {
    if (!sameTarget(target, this.current())) return;
    if (button.dataset.key === 'Paste') return this.paste(target);
    const data = terminalKey(button.dataset.key, target.term.modes);
    if (data !== null) target.term.input(data);
  }

  async paste(target) {
    if (!navigator.clipboard?.readText) return this.notify('This page cannot read the clipboard. Browsers allow that only on a secure (https) page.');
    let text;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return this.notify('The browser did not allow reading the clipboard. Allow clipboard access for this page, then try again.');
    }
    text = text.replace(/[\r\n]+$/, '');
    if (!text) return this.notify('The clipboard has no text to paste.');
    if (/[\r\n]/.test(text) && !target.term.modes.bracketedPasteMode) {
      return this.notify('Not pasted: the clipboard has more than one line, and this program would run each line as it arrives.');
    }
    if (!sameTarget(target, this.current())) return this.notify('Not pasted: the terminal cannot take input now.');
    target.term.paste(text);
  }
}

/** Fit the touch panel to a docked keyboard without changing global page layout. */
export function bindTerminalViewport(panel, controls) {
  bindVisibleViewport(panel, 'terminal', {
    shown: () => !panel.hidden && !controls.hidden,
    watch: [panel, controls],
    fitted: (height) => panel.toggleAttribute('data-compact', height !== null && height < 420),
  });
}
