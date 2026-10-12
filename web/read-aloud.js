// An agent's answer read aloud: every word of its Markdown except fenced code, spoken a chunk at a time.
import markdownit from './vendor/markdown-it.mjs';

export const CODE_OMITTED = 'Code omitted.';
// Chrome's network voices stop speaking an utterance after about 15 seconds.
export const MAX_CHUNK = 200;

// CommonMark, with GitHub's tables; raw HTML is read as text.
const markdown = markdownit();

/** The words of inline content: text, code spans and image descriptions, a line break where the source had one. */
function inlineText(token) {
  return token.children.map((child) => {
    if (child.type === 'text' || child.type === 'code_inline') return child.content;
    if (child.type === 'image') return child.content;
    if (child.type === 'softbreak' || child.type === 'hardbreak') return '\n';
    return '';
  }).join('');
}

/**
 * The words to speak, a line per paragraph line, heading, list item and table row. Each fenced code block is spoken
 * as CODE_OMITTED; indented code is read as text. An ordered list item keeps its number.
 */
export function spokenText(source) {
  const lines = [];
  const push = (text) => lines.push(...text.split('\n').map((line) => line.trim()).filter(Boolean));
  let number = '';
  let row = null;
  for (const token of markdown.parse(String(source), {})) {
    if (token.type === 'fence') {
      number = '';
      lines.push(CODE_OMITTED);
    } else if (token.type === 'code_block') push(token.content);
    else if (token.type === 'list_item_open') number = token.info ? `${token.info}${token.markup} ` : '';
    else if (token.type === 'tr_open') row = [];
    else if (token.type === 'tr_close') {
      push(row.filter(Boolean).join(', '));
      row = null;
    } else if (token.type === 'inline') {
      const text = inlineText(token).trim();
      if (row) row.push(text);
      else push(number + text);
      number = '';
    }
  }
  return lines.join('\n');
}

/** Pieces of at most `max` characters: one per line and sentence, a long sentence cut at its last pause or space. */
export function speechChunks(text, max = MAX_CHUNK) {
  const chunks = [];
  for (const line of text.split('\n')) {
    for (let rest of line.split(/(?<=[.!?])\s+/)) {
      rest = rest.trim();
      while (rest.length > max) {
        const head = rest.slice(0, max + 1);
        const pause = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
        const cut = pause > 0 ? pause + 1 : head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : max;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) chunks.push(rest);
    }
  }
  return chunks;
}

/**
 * Speaks one answer at a time. Each chunk starts when the previous one ends; a new read or stop() leaves the old
 * read's callbacks with nothing to do.
 */
export function createReader({ synth, Utterance, changed = () => {} }) {
  let run = 0;
  const reader = {
    session: null,
    read(session, markdown) {
      reader.stop();
      const ticket = run;
      const chunks = speechChunks(spokenText(markdown));
      const finish = () => {
        if (ticket !== run) return;
        run++;
        reader.session = null;
        changed();
      };
      const speak = (index) => {
        if (ticket !== run) return;
        if (index >= chunks.length) return finish();
        const utterance = new Utterance(chunks[index]);
        utterance.onend = () => speak(index + 1);
        utterance.onerror = finish;
        synth.speak(utterance);
      };
      reader.session = session;
      changed();
      speak(0);
    },
    stop() {
      run++;
      synth.cancel();
      if (reader.session === null) return;
      reader.session = null;
      changed();
    },
  };
  return reader;
}
