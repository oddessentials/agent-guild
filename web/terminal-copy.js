// A frozen copy surface keeps native touch selection separate from terminal gestures.
const SELECT_HINT = 'Touch and hold to select text.';

export function captureTerminalText(term) {
  const buffer = term.buffer.active;
  const lines = [];
  let viewportLine = 0;
  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    const text = line.translateToString(true, 0, term.cols).replace(/\u00a0/g, ' ');
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
    if (y === buffer.viewportY) viewportLine = lines.length - 1;
  }
  return { text: lines.join('\n'), viewportLine };
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
    const touch = matchMedia('(any-pointer: coarse)');
    const availability = () => { opener.hidden = !touch.matches && !navigator.maxTouchPoints; };
    touch.addEventListener('change', availability);
    availability();
    opener.addEventListener('click', () => this.open());
    this.copyButton.addEventListener('click', () => this.copy());
    dialog.querySelector('[data-done]').addEventListener('click', () => this.close(true));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); this.close(true); });
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
    const lineHeight = parseFloat(getComputedStyle(this.text).lineHeight);
    this.text.scrollTop = snapshot.viewportLine * lineHeight;
    this.text.scrollLeft = 0;
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

  close(restoreFocus = false) {
    const current = this.current;
    this.clear();
    if (this.dialog.open) this.dialog.close();
    if (restoreFocus && current && this.getCurrent()?.term === current.term) current.term.focus();
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
