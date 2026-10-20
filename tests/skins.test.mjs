import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Every skin must define these for light; the colour tokens again for dark.
const TOKENS = ['--bg', '--surface', '--surface-2', '--border', '--text', '--muted', '--heading', '--accent', '--accent-fill', '--accent-text',
  '--danger', '--ok', '--warn', '--gold', '--gold-ink', '--focus', '--shadow', '--radius', '--font-display'];
const DARK_TOKENS = TOKENS.filter((t) => !['--accent-text', '--radius', '--font-display'].includes(t));

const web = new URL('../web/', import.meta.url);
const html = readFileSync(new URL('index.html', web), 'utf8');
const providers = JSON.parse(readFileSync(new URL('../config/providers.default.json', import.meta.url), 'utf8')).providers.map((p) => p.id);

/** The skins list exactly as theme.js builds it in the browser. */
function skins() {
  const window = { matchMedia: () => ({ matches: false }) };
  const document = { documentElement: { dataset: {} } };
  const localStorage = { getItem: () => null };
  runInNewContext(readFileSync(new URL('theme.js', web), 'utf8'), { window, document, localStorage });
  return window.agentGuildSkins;
}

/** The bodies of every top-level block with exactly this selector, joined. */
function blocks(css, selector) {
  let out = '';
  for (let at = css.indexOf(`${selector} {`); at !== -1; at = css.indexOf(`${selector} {`, at + 1)) {
    if (at > 0 && css[at - 1] !== '\n') continue;
    let depth = 0;
    const start = css.indexOf('{', at);
    for (let i = start; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) { out += css.slice(start + 1, i); break; }
    }
  }
  return out;
}

/** Custom properties declared directly in a block body, not inside nested rules. */
function declared(body) {
  const names = new Set();
  let depth = 0;
  for (const part of body.split(/([{}])/)) {
    if (part === '{') depth++;
    else if (part === '}') depth--;
    else if (depth === 0) for (const m of part.matchAll(/(--[\w-]+)\s*:/g)) names.add(m[1]);
  }
  return names;
}

const list = skins();

test('theme.js lists skins with unique, valid ids', () => {
  assert.ok(Array.isArray(list) && list.length > 0);
  assert.equal(new Set(list.map((s) => s.id)).size, list.length);
  for (const skin of list) assert.match(skin.id, /^[a-z][a-z0-9-]*$/, skin.id);
});

test('a page with no saved skin starts in Professional', () => {
  const document = { documentElement: { dataset: {} } };
  runInNewContext(readFileSync(new URL('theme.js', web), 'utf8'),
    { window: { matchMedia: () => ({ matches: false }) }, document, localStorage: { getItem: () => null } });
  assert.equal(document.documentElement.dataset.skin, 'professional');
});

test('card art starts off for a new page, on for a page that has used Agent Guild, and keeps the choice', () => {
  const start = (saved) => {
    const storage = new Map(Object.entries(saved));
    const localStorage = {
      getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)),
      get length() { return storage.size; }, key: (i) => [...storage.keys()][i] ?? null,
    };
    const document = { documentElement: { dataset: {} } };
    runInNewContext(readFileSync(new URL('theme.js', web), 'utf8'), { window: { matchMedia: () => ({ matches: false }) }, document, localStorage });
    return [document.documentElement.dataset.art, storage.get('agentGuild.art')];
  };
  assert.deepEqual(start({}), ['off', 'off']);
  assert.deepEqual(start({ 'other.key': '1' }), ['off', 'off']);
  assert.deepEqual(start({ 'agentGuild.token': 't' }), ['on', 'on']);
  assert.deepEqual(start({ 'agentGuild.token': 't', 'agentGuild.art': 'off' }), ['off', 'off']);
  assert.deepEqual(start({ 'agentGuild.art': 'on' }), ['on', 'on']);
  assert.deepEqual(start({ 'agentGuild.art': 'sideways' }), ['off', 'off']);
});

test('with card art off, styles.css draws each tool icon from a shipped file', () => {
  const css = readFileSync(new URL('styles.css', web), 'utf8');
  for (const p of providers) {
    const rule = css.match(new RegExp(`:root\\[data-art="off"\\] \\.provider-icon:not\\(\\.has-image\\)\\[data-provider="${p}"\\] \\{ background-image: url\\("([^"]+)"\\); \\}`));
    assert.ok(rule, p);
    assert.ok(existsSync(new URL(rule[1], web)), rule[1]);
  }
  const hidden = css.match(/:root\[data-art="off"\] \.provider-icon:not\(\.has-image\)([^{]*) \{[^}]*color: transparent;/);
  assert.ok(hidden, 'the rule that hides the letters');
  assert.deepEqual([...hidden[1].matchAll(/\[data-provider="([\w-]+)"\]/g)].map((m) => m[1]).sort(), [...providers].sort(), 'only tools with a drawn icon lose their letters');
});

for (const { id } of list) {
  const file = new URL(`skins/${id}/skin.css`, web);

  test(`skin "${id}": stylesheet exists and index.html links it`, () => {
    assert.ok(existsSync(file), `web/skins/${id}/skin.css`);
    assert.ok(html.includes(`<link rel="stylesheet" href="/skins/${id}/skin.css">`), `index.html links /skins/${id}/skin.css`);
  });

  test(`skin "${id}": defines every token for light and the colour tokens for dark`, () => {
    const css = readFileSync(file, 'utf8');
    const light = declared(blocks(css, `:where(:root[data-skin="${id}"])`));
    const dark = declared(blocks(css, `:where(:root[data-skin="${id}"][data-theme="dark"])`));
    assert.deepEqual(TOKENS.filter((t) => !light.has(t)), [], 'missing light tokens');
    assert.deepEqual(DARK_TOKENS.filter((t) => !dark.has(t)), [], 'missing dark tokens');
  });

  test(`skin "${id}": keyframes are prefixed with the skin id`, () => {
    const css = readFileSync(file, 'utf8');
    const names = [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    assert.deepEqual(names.filter((n) => !n.startsWith(`${id}-`)), []);
  });

  test(`skin "${id}": the notes field is styled with the working-folder field`, () => {
    const css = readFileSync(file, 'utf8').replace(/\/\*[^]*?\*\//g, '');
    const lists = [...css.matchAll(/([^{};]+)\{/g)].map((m) => m[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim()));
    for (const list of lists.filter((l) => l.includes('.cwd input'))) assert.ok(list.includes('.notes-text'), list.join(', '));
  });

  // Shell's art is the default every card starts from; each other provider overrides it with its own.
  test(`skin "${id}": every provider has its own card art and icon`, () => {
    const css = readFileSync(file, 'utf8');
    const own = (p) => css.includes(`.provider[data-id="${p}"], .session-card[data-provider="${p}"] {`) && css.includes(`.provider-icon[data-provider="${p}"] {`);
    assert.deepEqual(providers.filter((p) => p !== 'shell' && !own(p)), []);
  });

  test(`skin "${id}": every relative url() points to a file`, () => {
    const css = readFileSync(file, 'utf8');
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]).filter((u) => !/^(data:|\/|#|https?:)/.test(u));
    assert.ok(urls.length > 0);
    assert.deepEqual(urls.filter((u) => !existsSync(new URL(u, file))), []);
  });
}
