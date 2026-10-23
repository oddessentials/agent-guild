// The words of an agent's Markdown answer as Read aloud speaks them. The page and the manager run this same code,
// each with its own build of markdown-it: the page its /vendor browser build, the manager the package itself.

export const CODE_OMITTED = 'Code omitted.';

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
 * spokenText(source) for this markdown-it: the words to speak, a line per paragraph line, heading, list item and
 * table row. Each fenced code block is spoken as CODE_OMITTED; indented code is read as text. An ordered list item
 * keeps its number.
 */
export function spokenTextWith(markdownit) {
  // CommonMark, with GitHub's tables; raw HTML is read as text.
  const markdown = markdownit();
  return function spokenText(source) {
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
  };
}
