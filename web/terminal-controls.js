const ARROWS = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D' };

/** Use the same cursor mode as a physical keyboard, including inside full-screen tools. */
export function terminalKey(key, modes) {
  if (Object.hasOwn(ARROWS, key)) return `\x1b${modes.applicationCursorKeysMode ? 'O' : '['}${ARROWS[key]}`;
  if (key === 'Enter') return '\r';
  if (key === 'Escape') return '\x1b';
  return null;
}

const sameTarget = (a, b) => Boolean(a && b && a.term === b.term && a.socket === b.socket && a.run === b.run);

/** Six ordinary buttons. A gesture belongs to the session and connection where it began. */
export class TerminalControls {
  constructor({ element, panel, getCurrent }) {
    this.element = element;
    this.getCurrent = getCurrent;
    this.buttons = [...element.querySelectorAll('button')];
    const touch = matchMedia('(any-pointer: coarse)');
    const availability = () => {
      element.hidden = !touch.matches && !navigator.maxTouchPoints;
      this.refresh();
    };
    touch.addEventListener('change', availability);
    for (const button of this.buttons) {
      button.addEventListener('pointerdown', (event) => {
        this.cancel();
        if (!event.isPrimary || event.button !== 0 || button.disabled) return;
        // Retain xterm's focus if typing, and leave the keyboard closed if it is closed.
        event.preventDefault();
        const target = this.current();
        if (!target) return;
        this.press = { button, target, pointer: event.pointerId };
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
    addEventListener('blur', () => this.cancel());
    addEventListener('pagehide', () => this.cancel());
    document.addEventListener('visibilitychange', () => { this.cancel(); this.refresh(); });
    // Modal Copy (and other dialogs) must cancel a press even if it closes before release.
    new MutationObserver(() => { this.cancel(); this.refresh(); }).observe(document.body, {
      subtree: true, attributes: true, attributeFilter: ['open'],
    });
    new MutationObserver(() => this.refresh()).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    availability();
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
    const data = terminalKey(button.dataset.key, target.term.modes);
    if (data !== null) target.term.input(data);
  }
}

/** Fit the touch panel to a docked keyboard without changing global page layout. */
export function bindTerminalViewport(panel, controls) {
  const viewport = window.visualViewport;
  let frame;
  const update = () => {
    if (panel.hidden || controls.hidden) {
      panel.style.removeProperty('--terminal-viewport-top');
      panel.style.removeProperty('--terminal-viewport-bottom');
      delete panel.dataset.compact;
      return;
    }
    // Magnification belongs to the browser; it must not resize the shared PTY.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
    const top = viewport?.offsetTop || 0;
    const height = viewport?.height ?? innerHeight;
    panel.style.setProperty('--terminal-viewport-top', `${top}px`);
    panel.style.setProperty('--terminal-viewport-bottom', `${Math.max(0, innerHeight - top - height)}px`);
    panel.toggleAttribute('data-compact', height < 420);
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  addEventListener('resize', schedule);
  addEventListener('pageshow', schedule);
  const observer = new MutationObserver(schedule);
  for (const element of [panel, controls]) observer.observe(element, { attributes: true, attributeFilter: ['hidden'] });
  schedule();
}
