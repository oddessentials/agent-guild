// An agent's answer read aloud: every word of its Markdown except fenced code, spoken a chunk at a time.

export const CODE_OMITTED = 'Code omitted.';
// Chrome's network voices stop speaking an utterance after about 15 seconds.
export const MAX_CHUNK = 200;

const FENCE_OPEN = /^\s*(`{3,}|~{3,})(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
// A thematic break, or a setext heading's underline.
const RULE = /^\s*(([-*_])(\s*\2){2,}|=+)\s*$/;
const CODE_SPAN = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g;

/** Markdown inline syntax dropped from text outside code spans; the words stay. */
function plainInline(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/\*+|~~/g, '')
    .replace(/(^|[^\p{L}\p{N}_])_+(?=\S)/gu, '$1')
    .replace(/(\S)_+(?![\p{L}\p{N}_])/gu, '$1');
}

function plainLine(line) {
  let out = '';
  let last = 0;
  for (const match of line.matchAll(CODE_SPAN)) {
    out += plainInline(line.slice(last, match.index)) + match[2];
    last = match.index + match[0].length;
  }
  return (out + plainInline(line.slice(last))).replace(/`/g, '');
}

/**
 * The words to speak. A fence opens on a line that starts, after any indent, with three or more backticks or tildes
 * (a backtick fence's info has no backtick) and closes on a line of the same character, at least as many, and
 * nothing else; an unclosed fence runs to the end. Each fenced block is spoken as CODE_OMITTED.
 */
export function spokenText(markdown) {
  const lines = [];
  let fence = null;
  for (const raw of String(markdown).replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const close = raw.trim();
      if (close.length >= fence.length && close === fence[0].repeat(close.length)) fence = null;
      continue;
    }
    const open = raw.match(FENCE_OPEN);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = open[1];
      lines.push(CODE_OMITTED);
      continue;
    }
    if ((raw.includes('|') && TABLE_DIVIDER.test(raw)) || RULE.test(raw)) continue;
    let line = raw
      .replace(/^\s*(>\s?)+/, '')
      .replace(/^\s*#{1,6}(\s+|$)/, '')
      .replace(/\s+#+\s*$/, '')
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '');
    if (/^\s*\|/.test(line)) line = line.split('|').map((cell) => cell.trim()).filter(Boolean).join(', ');
    line = plainLine(line).trim();
    if (line) lines.push(line);
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
