import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// A card's note sits above its buttons. A copy another installer updates gets one short line there; the
// full sentence stays in the Installation list. Runs the real renderHint from app.js against stub elements.
const app = fs.readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const source = [
  app.match(/const MANAGED_UPDATES = \{[^]*?\n\};/)?.[0],
  ...['renderHint', 'httpsHref'].map((name) => app.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'))?.[0]),
];
assert.ok(source.every(Boolean), 'MANAGED_UPDATES, renderHint and httpsHref are present in app.js');

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.hidden = false; this.title = ''; this.className = ''; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, fn) { this[type] = fn; }
  querySelector(selector) { return this.children.find((node) => node instanceof Element && node.tag === selector); }
  focus() { this.focused = true; }
  scrollIntoView() {}
  get text() { return this.children.map((node) => node instanceof Element ? `[${node.textContent}]` : node).join(''); }
}

const guidance = 'Docker Desktop installed Docker Agent at ~/.docker/cli-plugins/docker-agent; Docker Desktop updates and removes it.';
const docker = (overrides = {}) => ({
  available: true, updateAvailable: true, updateCommand: null, installChannel: 'desktop', updateGuidance: guidance,
  docs: 'https://docs.docker.com/ai/docker-agent/', installs: [{ active: true, channel: 'desktop', uninstallGuidance: guidance }],
  ...overrides,
});

function render(provider, { listed = true } = {}) {
  const context = { document: { createElement: (tag) => new Element(tag) }, URL };
  vm.runInNewContext(source.join('\n'), context);
  const hint = new Element('p');
  const copies = new Element('details');
  copies.hidden = !listed;
  copies.open = false;
  copies.append(new Element('summary'));
  context.renderHint(hint, provider, copies);
  return { hint, copies };
}

test('the card note is its own line above the buttons, not inside their row', () => {
  const card = html.match(/<template id="provider-template">[^]*?<\/template>/)[0];
  const actions = card.match(/<div class="provider-actions">[^]*?<\/div>/)[0];
  assert.doesNotMatch(actions, /hint/);
  assert.ok(card.indexOf('class="hint"') < card.indexOf('class="provider-actions"'));
});

test('a Docker Desktop copy with an update says so in one line, with the full sentence one tap away', () => {
  const { hint, copies } = render(docker());
  assert.equal(hint.hidden, false);
  assert.equal(hint.text, 'Docker Desktop updates this copy. [Details] · [Docs]');
  assert.equal(hint.title, guidance);
  const details = hint.children.find((node) => node.className === 'hint-details');
  details.click();
  assert.equal(copies.open, true, 'Details opens the Installation list');
  assert.equal(copies.querySelector('summary').focused, true);
  const docs = hint.children.find((node) => node.tag === 'a');
  assert.equal(docs.href, 'https://docs.docker.com/ai/docker-agent/');
  assert.equal(docs.target, '_blank');
});

test('the full sentence stays on the card when the Installation list does not carry it', () => {
  assert.equal(render(docker(), { listed: false }).hint.text, `${guidance} [Docs]`);
  const other = 'Agent Guild does not know how Docker Agent was installed.';
  assert.equal(render(docker({ installs: [{ active: true, uninstallGuidance: other }] })).hint.text, `${guidance} [Docs]`);
  const unknown = 'Docker Agent at /opt/docker-agent was not downloaded by Agent Guild. Update it the way you installed it.';
  assert.equal(render(docker({ installChannel: 'unknown', updateGuidance: unknown, installs: [{ active: true, uninstallGuidance: unknown }] })).hint.text, `${unknown} [Docs]`);
});

test('a card with nothing to say keeps its note hidden', () => {
  const { hint } = render(docker({ updateAvailable: false }));
  assert.equal(hint.hidden, true);
  assert.equal(hint.text, '');
});
