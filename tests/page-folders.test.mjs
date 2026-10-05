import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const pick = (names) => names.map((name) => app.match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
const constant = (name) => app.match(new RegExp(`const ${name} = [^]*?;\\n`))[0];

function element(props = {}) {
  return {
    textContent: '', hidden: false, disabled: false, value: '', checked: false, title: '', open: false, children: [], attrs: {}, classes: new Set(),
    classList: { toggle(name, on) { this.owner.classes[on ? 'add' : 'delete'](name); } },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attrs[key] = value; },
    querySelector() { return this.children[0] ?? null; },
    focus() { focused.push(this); },
    showModal() { this.open = true; },
    close() { this.open = false; },
    ...props,
  };
}
let focused = [];

function page({ answers = [] } = {}) {
  focused = [];
  const ids = {};
  const $ = (id) => {
    ids[id] ??= element();
    ids[id].classList.owner = ids[id];
    return ids[id];
  };
  const requests = [], saved = {}, used = [], auth = [], reloads = [];
  const context = {
    state: { connected: true },
    $,
    load: (key) => saved[key] ?? null,
    save: (key, value) => { saved[key] = value; },
    button: (label, onClick, className) => {
      const node = element({ textContent: label, className, onClick });
      node.classList.owner = node;
      return node;
    },
    api: async (method, path) => {
      requests.push([method, path]);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer() : answer;
    },
    AuthError: class extends Error {},
    showAuth: (message) => auth.push(message),
    useFolder: (dir) => used.push(dir),
    loadRepos: () => reloads.push(true),
    cloneParent: () => $('github-parent').value.trim(),
    document: { activeElement: null },
    Object,
  };
  runInNewContext(`${constant('FOLDER_FIELDS')}${constant('HIDDEN_FOLDERS_KEY')}${constant('CLONE_PARENT_KEY')}${constant('folderView')}
${pick(['chooseFolder', 'browseTo', 'renderFolderBrowser', 'setCloneParent', 'useBrowsedFolder'])}
this.folderView = folderView;`, context);
  return { context, $, requests, saved, used, auth, reloads };
}

const listing = {
  path: '/work/space', parent: '/work', home: '/home/me',
  segments: [{ name: '/', path: '/' }, { name: 'work', path: '/work' }, { name: 'space', path: '/work/space' }],
  roots: [{ name: '/', path: '/' }],
  entries: [{ name: '.cache', path: '/work/space/.cache', hidden: true }, { name: 'Alpha <b>', path: '/work/space/Alpha <b>', hidden: false }, { name: 'beta', path: '/work/space/beta', hidden: false }],
  truncated: false, note: null,
};

test('choosing opens at the field value and lists the folders there, hidden ones on request', async () => {
  const p = page({ answers: [listing] });
  p.$('cwd').value = '  /work/space & more ';
  p.context.chooseFolder('cwd');
  assert.equal(p.$('folder-browser').open, true);
  assert.equal(p.$('folder-title').textContent, 'Choose working folder');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(p.requests, [['GET', '/folders?path=%2Fwork%2Fspace%20%26%20more']]);
  assert.deepEqual(p.$('folder-list').children.map((row) => row.textContent), ['Alpha <b>', 'beta']);
  assert.deepEqual(p.$('folder-path').children.map((crumb) => crumb.textContent), ['/', 'work', 'space']);
  assert.equal(p.$('folder-path').children[2].attrs['aria-current'], 'location');
  assert.equal(p.$('folder-current').textContent, '/work/space');
  assert.equal(p.$('folder-use').disabled, false);
  assert.equal(p.$('folder-up').disabled, false);
  assert.equal(focused.at(-1).textContent, 'Alpha <b>');
  p.$('folder-hidden').checked = true;
  p.context.renderFolderBrowser();
  assert.deepEqual(p.$('folder-list').children.map((row) => row.textContent), ['.cache', 'Alpha <b>', 'beta']);
  assert.equal(p.$('folder-list').children[0].classes.has('hidden-folder'), true);
  p.$('folder-filter').value = 'BET';
  p.context.renderFolderBrowser();
  assert.deepEqual(p.$('folder-list').children.map((row) => row.textContent), ['beta']);
  p.$('folder-filter').value = 'zzz';
  p.context.renderFolderBrowser();
  assert.equal(p.$('folder-status').textContent, 'No folders match.');
});

test('the browser explains fallbacks, empty folders and cut listings', async () => {
  const p = page({ answers: [{ ...listing, note: '/work/space/gone', entries: [] }, { ...listing, truncated: true }] });
  p.$('folder-browser').open = true;
  await p.context.browseTo('/work/space/gone');
  assert.equal(p.$('folder-note').hidden, false);
  assert.match(p.$('folder-note').textContent, /^\/work\/space\/gone was not found/);
  assert.equal(p.$('folder-status').textContent, 'No folders here.');
  assert.equal(focused.at(-1), p.$('folder-use'));
  await p.context.browseTo('/work/space');
  assert.equal(p.$('folder-note').hidden, true);
  assert.equal(p.$('folder-status').textContent, 'Showing the first 3 folders.');
});

test('a failed listing keeps the current folder and shows why; a sign-in failure leaves for sign-in', async () => {
  const p = page({ answers: [listing, Object.assign(new Error('Agent Guild cannot read /work/space/beta.'), { code: 'folder_unreadable' })] });
  await p.context.browseTo('/work/space');
  await p.context.browseTo('/work/space/beta');
  assert.equal(p.$('folder-status').textContent, 'Agent Guild cannot read /work/space/beta.');
  assert.equal(p.$('folder-status').classes.has('error'), true);
  assert.equal(p.$('folder-current').textContent, '/work/space');
  assert.equal(p.$('folder-use').disabled, false);
  const signedOut = page();
  signedOut.context.api = async () => { throw new signedOut.context.AuthError('Token rejected'); };
  signedOut.$('folder-browser').open = true;
  await signedOut.context.browseTo('');
  assert.deepEqual(signedOut.auth, ['Token rejected']);
  assert.equal(signedOut.$('folder-browser').open, false);
});

test('a slower earlier listing never replaces a newer one', async () => {
  let finishFirst;
  const p = page({ answers: [() => new Promise((resolve) => { finishFirst = resolve; }), { ...listing, path: '/work' }] });
  const first = p.context.browseTo('/work/space');
  await p.context.browseTo('/work');
  finishFirst(listing);
  await first;
  assert.equal(p.$('folder-current').textContent, '/work');
});

test('using a folder fills the field it was opened for', async () => {
  const p = page({ answers: [listing, listing] });
  p.context.chooseFolder('cwd');
  await new Promise((resolve) => setImmediate(resolve));
  p.context.useBrowsedFolder();
  assert.deepEqual(p.used, ['/work/space']);
  assert.equal(p.$('folder-browser').open, false);
  p.context.chooseFolder('clone');
  assert.equal(p.$('folder-title').textContent, 'Choose clone folder');
  await new Promise((resolve) => setImmediate(resolve));
  p.context.useBrowsedFolder();
  assert.equal(p.$('github-parent').value, '/work/space');
  assert.equal(p.saved['agentGuild.cloneParent'], '/work/space');
  assert.equal(p.reloads.length, 1);
  assert.deepEqual(p.used, ['/work/space']);
});
