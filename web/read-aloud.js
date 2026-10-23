// An agent's answer read aloud: every word of its Markdown except fenced code, spoken a chunk at a time.
import markdownit from './vendor/markdown-it.mjs';
import { CODE_OMITTED, spokenTextWith } from './spoken-text.js';

export { CODE_OMITTED };
// Chrome's network voices stop speaking an utterance after about 15 seconds.
export const MAX_CHUNK = 200;

/** The words to speak; see spoken-text.js. */
export const spokenText = spokenTextWith(markdownit);

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
