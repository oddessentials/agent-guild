// A frozen copy surface keeps native touch selection separate from terminal gestures.
import { onTouchTyping } from './layout.js';

const SELECT_HINT = 'Touch and hold to select text.';

export function captureTerminalText(term) {
  const buffer = term.buffer.active;
  const lines = [];
  let viewportLine = 0;
  let viewportPrefix = '';
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    const text = line.translateToString(true, 0, term.cols);
    const wrapped = line.isWrapped && lines.length > 0;
    if (y === buffer.viewportY) {
      viewportLine = wrapped ? lines.length - 1 : lines.length;
      // The visible row can begin inside a joined line. Keep its actual text
      // prefix: terminal cells and JavaScript character counts differ for Unicode.
      viewportPrefix = wrapped ? lines[lines.length - 1] : '';
    }
    if (wrapped) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return { text: lines.join('\n'), viewportLine, viewportPrefix };
}

export class TerminalCopy {
  constructor({ opener, dialog, getCurrent }) {
    this.dialog = dialog;
    this.getCurrent = getCurrent;
    this.text = dialog.querySelector('textarea');
    this.copyButton = dialog.querySelector('[data-copy]');
    this.status = dialog.querySelector('[role="status"]');
    this.current = null;
    this.attempt = null;
    onTouchTyping((touch) => { opener.hidden = !touch; });
    opener.addEventListener('click', () => this.open());
    this.copyButton.addEventListener('click', () => this.copy());
    dialog.querySelector('[data-done]').addEventListener('click', () => this.close());
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(); });
    // A programmatic/native close can arrive after the sheet has already reopened.
    dialog.addEventListener('close', () => { if (!dialog.open) this.clear(); });
    this.text.addEventListener('select', () => this.selectionChanged());
    document.addEventListener('selectionchange', () => {
      if (dialog.open) this.selectionChanged();
    });
  }

  open() {
    if (this.dialog.open) return;
    const current = this.getCurrent();
    if (!current) return;
    const snapshot = captureTerminalText(current.term);
    this.current = current;
    this.selection = '0:0';
    this.text.value = snapshot.text;
    this.dialog.querySelector('[data-session]').textContent = current.name;
    this.status.textContent = SELECT_HINT;
    this.copyButton.disabled = true;
    this.dialog.showModal();
    this.text.focus({ preventScroll: true });
    this.text.setSelectionRange(0, 0);
    const style = getComputedStyle(this.text);
    this.text.scrollTop = snapshot.viewportLine * parseFloat(style.lineHeight);
    this.text.scrollLeft = 0;
    if (snapshot.viewportPrefix) {
      const measure = document.createElement('canvas').getContext('2d');
      measure.font = style.font;
      this.text.scrollLeft = measure.measureText(snapshot.viewportPrefix).width;
    }
  }

  selectionChanged() {
    const selection = `${this.text.selectionStart}:${this.text.selectionEnd}`;
    if (selection !== this.selection && this.status.textContent === 'Copied') {
      this.status.textContent = SELECT_HINT;
    }
    this.selection = selection;
    this.copyButton.disabled = Boolean(this.attempt) || this.text.selectionStart === this.text.selectionEnd;
  }

  async copy() {
    const current = this.current;
    if (!current || this.attempt) return;
    const range = `${this.text.selectionStart}:${this.text.selectionEnd}`;
    const selected = this.text.value.slice(this.text.selectionStart, this.text.selectionEnd);
    if (!selected) return;
    const attempt = this.attempt = {};
    this.copyButton.disabled = true;
    this.status.textContent = 'Copying…';
    try {
      // Stay in the user's click activation; no permission preflight or clipboard read.
      // Textareas normalize newlines to LF; match xterm's Windows copy convention.
      const text = /Win/.test(navigator.platform) ? selected.replace(/\n/g, '\r\n') : selected;
      await navigator.clipboard.writeText(text);
      if (this.current === current && this.attempt === attempt) {
        this.status.textContent = range === `${this.text.selectionStart}:${this.text.selectionEnd}` ? 'Copied' : SELECT_HINT;
      }
    } catch {
      if (this.current === current && this.attempt === attempt) {
        this.status.textContent = 'Use Copy in the text selection menu.';
        this.text.focus({ preventScroll: true });
      }
    } finally {
      if (this.attempt === attempt) {
        this.attempt = null;
        this.selectionChanged();
      }
    }
  }

  close() {
    this.clear();
    if (this.dialog.open) this.dialog.close();
  }

  clear() {
    this.current = null;
    this.attempt = null;
    this.text.value = '';
    this.status.textContent = '';
    this.dialog.querySelector('[data-session]').textContent = '';
    this.copyButton.disabled = true;
  }
}
