import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// The What's new footer carries the support link. Run the real footer
// renderer from app.js against stub elements, without booting the DOM.
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const constants = ['RELEASES_URL', 'SUPPORT_URL'].map((name) => {
  const found = app.match(new RegExp(`const ${name} = '[^']+';`))?.[0];
  assert.ok(found, `${name} is present in app.js`);
  return found;
});
const functions = ['function webHref', 'function el', 'function externalLink', 'function releasesLink', 'function renderChangelogStatus'].map((name) => {
  const found = app.match(new RegExp(`${name}\\([^]*?\\n\\}`))?.[0];
  assert.ok(found, `${name} is present in app.js`);
  return found;
});

test('the What\'s new footer links to the support page in a new tab', () => {
  const element = (tag) => ({
    tag, attrs: {}, children: [], hidden: true, href: '',
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attrs[name] = value; },
  });
  const status = element('p');
  const context = { document: { createElement: element }, $: () => status, URL };
  runInNewContext([...constants, ...functions].join('\n'), context);

  context.renderChangelogStatus(null);
  const links = status.children.flatMap((line) => line.children).filter((node) => node.tag === 'a');
  const support = links.find((link) => link.href.startsWith('https://oddessentials.ai/donate/'));
  assert.ok(support, 'the footer has a support link');
  assert.equal(support.href, 'https://oddessentials.ai/donate/?ref=agent-guild');
  assert.equal(support.target, '_blank');
  assert.equal(support.rel, 'noopener noreferrer');
  assert.equal(support.attrs['aria-description'], 'Opens in a new tab');
  assert.equal(status.hidden, false);
});
