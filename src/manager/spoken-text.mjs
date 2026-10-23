// The words Read aloud speaks for an answer, from the page's own code (web/spoken-text.js) with markdown-it's
// Node build.

import markdownit from 'markdown-it';
import { spokenTextWith } from '../../web/spoken-text.js';

export const spokenText = spokenTextWith(markdownit);
