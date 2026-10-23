// Dictated words as terminal input. The page's Dictate and the manager's POST /sessions/:id/send both use it.

/** One line of text, no control characters, so nothing is ever submitted. A phrase after the first starts with a space. */
export function dictatedText(text, first) {
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean && (first ? clean : ` ${clean}`);
}
