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
    api: async (method, path, body) => {
      requests.push(body === undefined ? [method, path] : [method, path, body]);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer() : answer;
    },
    AuthError: class extends Error {},
    showAuth: (message) => auth.push(message),
    useFolder: (dir) => used.push(dir),
    rememberRecent: () => {},
    loadRepos: () => reloads.push(true),
    cloneParent: () => $('github-parent').value.trim(),
    document: { activeElement: null },
    Object,
  };
  runInNewContext(`${constant('FOLDER_FIELDS')}${constant('HIDDEN_FOLDERS_KEY')}${constant('CLONE_PARENT_KEY')}${constant('folderView')}
${pick(['chooseFolder', 'showNewFolder', 'createFolder', 'newFolderKeys', 'browseTo', 'renderFolderBrowser', 'folderBrowserClosed', 'setCloneParent', 'useBrowsedFolder'])}
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

test('only folders chosen in the browser or started in successfully become recent', async () => {
  const helpers = await import('../web/folders.js');
  const run = (names, extra) => {
    const saved = {}, context = {
      state: { platform: 'win32' },
      load: (key) => saved[key] ?? null,
      save: (key, value) => { saved[key] = value; },
      ...helpers, ...extra,
    };
    runInNewContext(`${constant('RECENT_CWDS_KEY')}${constant('RECENT_CLONE_PARENTS_KEY')}${constant('RECENT_FIELDS')}${pick(['recentFolders', 'rememberRecent', ...names])}`, context);
    return { context, recent: (key = 'agentGuild.recentCwds') => JSON.parse(saved[key] ?? '[]') };
  };
  const field = { value: ' typed/path ' };
  const starting = (answer) => run(['startSession'], {
    $: () => field, CWD_KEY: 'agentGuild.cwd', selectedAccount: () => ({ id: 'default' }), pickedShell: () => null,
    api: async () => { if (answer instanceof Error) throw answer; return { session: answer }; },
    upsertSession() {}, closeHistory() {}, openPanel() {}, toast() {}, AuthError: class extends Error {},
  });
  const started = starting({ id: 'a', cwd: 'C:/Work/Guild' });
  await started.context.startSession({ id: 'fake' }, null);
  assert.deepEqual(started.recent(), ['C:/Work/Guild']);
  const failed = starting(Object.assign(new Error('working directory does not exist'), { code: 'bad_cwd' }));
  await failed.context.startSession({ id: 'fake' }, null);
  assert.deepEqual(failed.recent(), []);

  const browsed = run([], {});
  browsed.context.rememberRecent('cwd', 'C:/Work/Guild');
  browsed.context.rememberRecent('cwd', 'D:/Other');
  browsed.context.rememberRecent('cwd', 'c:/work/guild');
  browsed.context.rememberRecent('clone', 'E:/Clones');
  browsed.context.rememberRecent('clone', '');
  assert.deepEqual(browsed.recent(), ['c:/work/guild', 'D:/Other']);
  assert.deepEqual(browsed.recent('agentGuild.recentCloneParents'), ['E:/Clones']);
});

test('using a browsed folder records it as recent for the field it was opened for', async () => {
  const p = page({ answers: [listing, { ...listing, path: '/clones' }] });
  const remembered = [];
  p.context.rememberRecent = (field, dir) => remembered.push([field, dir]);
  p.context.chooseFolder('cwd');
  await new Promise((resolve) => setImmediate(resolve));
  p.context.useBrowsedFolder();
  p.context.chooseFolder('clone');
  await new Promise((resolve) => setImmediate(resolve));
  p.context.useBrowsedFolder();
  assert.deepEqual(JSON.parse(JSON.stringify(remembered)), [['cwd', '/work/space'], ['clone', '/clones']]);
});

function combobox(saved = {}) {
  const ids = {};
  const node = (props = {}) => {
    const handlers = {};
    const made = element({
      ...props,
      addEventListener: (type, handler) => { handlers[type] = handler; },
      fire: (type, event = { preventDefault() {} }) => handlers[type](event),
      removeAttribute(key) { delete this.attrs[key]; },
    });
    made.classList.owner = made;
    return made;
  };
  const $ = (id) => (ids[id] ??= node());
  const picked = [];
  const context = {
    state: { platform: 'linux' }, $,
    load: (key) => saved[key] ?? null,
    save: (key, value) => { saved[key] = value; },
    el: (tag, className, text) => node({ tagName: tag, className, textContent: text }),
    useFolder: (dir) => picked.push(['cwd', dir]),
    setCloneParent: (dir) => picked.push(['clone', dir]),
    readRecentFolders: (text) => JSON.parse(text ?? '[]'),
    rememberFolder: (list, dir) => [dir, ...list.filter((known) => known !== dir)],
    matchFolders: (list, query) => list.filter((dir) => dir.includes(query)),
    Object,
  };
  runInNewContext(`${constant('RECENT_CWDS_KEY')}${constant('RECENT_CLONE_PARENTS_KEY')}${constant('RECENT_FIELDS')}${constant('recentView')}
${pick(['recentFolders', 'rememberRecent', 'renderRecent', 'showRecent', 'hideRecent', 'pickRecent', 'recentKeys'])}`, context);
  return { context, $, picked, saved };
}

test('Clone into offers its own recent folders and picking one sets the clone folder', () => {
  const c = combobox({ 'agentGuild.recentCloneParents': JSON.stringify(['/clones/<b>', '/srv/repos']), 'agentGuild.recentCwds': JSON.stringify(['/work']) });
  c.context.showRecent('clone');
  const list = c.$('github-parent-recent');
  assert.equal(list.hidden, false);
  assert.deepEqual(list.children.map((o) => o.textContent), ['/clones/<b>', '/srv/repos']);
  assert.deepEqual(list.children.map((o) => o.id), ['github-parent-recent-0', 'github-parent-recent-1']);
  assert.equal(c.$('github-parent').attrs['aria-expanded'], 'true');
  assert.equal(c.$('cwd-recent').children.length, 0);
  c.context.recentKeys('clone', { key: 'ArrowUp', preventDefault() {} });
  assert.equal(c.$('github-parent').attrs['aria-activedescendant'], 'github-parent-recent-1');
  assert.equal(c.$('github-parent-recent').children[1].attrs['aria-selected'], 'true');
  c.context.recentKeys('clone', { key: 'Enter', preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(c.picked)), [['clone', '/srv/repos']]);
  assert.equal(c.$('github-parent-recent').hidden, true);
  assert.equal(c.$('github-parent').attrs['aria-expanded'], 'false');
  assert.deepEqual(JSON.parse(c.saved['agentGuild.recentCloneParents']), ['/clones/<b>', '/srv/repos']);

  c.$('github-parent').value = 'srv';
  c.context.showRecent('clone', true);
  assert.deepEqual(c.$('github-parent-recent').children.map((o) => o.textContent), ['/srv/repos']);
  c.$('github-parent-recent').children[0].fire('click');
  assert.deepEqual(JSON.parse(JSON.stringify(c.picked.at(-1))), ['clone', '/srv/repos']);
});

test('only one recent list is open at a time and blurring another field leaves it open', () => {
  const c = combobox({ 'agentGuild.recentCloneParents': JSON.stringify(['/clones']), 'agentGuild.recentCwds': JSON.stringify(['/work']) });
  c.context.showRecent('cwd');
  assert.equal(c.$('cwd-recent').hidden, false);
  c.context.showRecent('clone');
  assert.equal(c.$('cwd-recent').hidden, true);
  assert.equal(c.$('cwd').attrs['aria-expanded'], 'false');
  c.context.hideRecent('cwd');
  assert.equal(c.$('github-parent-recent').hidden, false);
  let prevented = false;
  c.context.recentKeys('clone', { key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(c.$('github-parent-recent').hidden, true);
  c.context.recentKeys('clone', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(c.$('github-parent-recent').hidden, false);
  assert.equal(c.$('github-parent').attrs['aria-activedescendant'], 'github-parent-recent-0');
  const empty = combobox();
  empty.context.showRecent('clone');
  assert.equal(empty.$('github-parent-recent').hidden, true);
  assert.equal(empty.$('github-parent').attrs['aria-expanded'], 'false');
});

test('a clone parent becomes recent only when a clone started here finishes', async () => {
  const remembered = [];
  const context = {
    githubPick: { origins: new Set() },
    dockShows: () => false, loadRepos() {}, toast() {}, useFolder() {}, upsertSession() {}, openPanel() {},
    cloneParent: () => '/srv/clones',
    api: async () => ({ session: { id: 's1' } }),
    rememberRecent: (field, dir) => remembered.push([field, dir]),
    Set, Map,
  };
  runInNewContext(`${constant('githubView')}${pick(['startClone', 'clonedPath', 'noticeClone'])}`, context);
  await context.startClone({ id: 'acct' }, 'me/repo');
  context.cloneParent = () => '/elsewhere';
  context.noticeClone({ id: 's1', task: 'clone', status: 'running', clone: { path: '/srv/clones/repo' } });
  context.noticeClone({ id: 'other', task: 'clone', status: 'exited', exitCode: 0, clone: { path: '/x/repo' } });
  assert.deepEqual(remembered, []);
  context.noticeClone({ id: 's1', task: 'clone', status: 'exited', exitCode: 0, clone: { path: '/srv/clones/repo' } });
  assert.deepEqual(JSON.parse(JSON.stringify(remembered)), [['clone', '/srv/clones']]);
  context.api = async () => ({ session: { id: 's2' } });
  await context.startClone({ id: 'acct' }, 'me/other');
  context.noticeClone({ id: 's2', task: 'clone', status: 'exited', exitCode: 128, clone: { path: '/elsewhere/other' } });
  assert.equal(remembered.length, 1);
});

test('a close event that arrives after reopening neither drops the new listing nor moves focus', async () => {
  const opener = element({ isConnected: true });
  const p = page({ answers: [listing, { ...listing, path: '/clones', segments: [], entries: [] }] });
  p.context.document.activeElement = opener;
  p.context.chooseFolder('cwd');
  await new Promise((resolve) => setImmediate(resolve));
  p.context.useBrowsedFolder();
  p.context.chooseFolder('clone');
  p.context.folderBrowserClosed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(p.$('folder-current').textContent, '/clones');
  assert.equal(p.$('folder-use').disabled, false);
  assert.equal(focused.includes(opener), false);
  p.$('folder-browser').close();
  p.context.folderBrowserClosed();
  assert.equal(focused.at(-1), opener);
});

test('a listing requested before closing cannot replace the listing of a reopened browser', async () => {
  let finishOld;
  const p = page({ answers: [() => new Promise((resolve) => { finishOld = resolve; }), { ...listing, path: '/fresh' }] });
  p.context.chooseFolder('cwd');
  p.$('folder-browser').close();
  p.context.folderBrowserClosed();
  p.context.chooseFolder('clone');
  await new Promise((resolve) => setImmediate(resolve));
  finishOld(listing);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(p.$('folder-current').textContent, '/fresh');
});

test('a new folder is created in the current folder and opened', async () => {
  const made = { ...listing, path: '/work/space/Alpha <b> & co', parent: '/work/space', entries: [] };
  const p = page({ answers: [listing, made] });
  await p.context.browseTo('/work/space');
  assert.equal(p.$('folder-new-open').disabled, false);
  p.$('folder-new').hidden = true;
  p.context.showNewFolder(true);
  assert.equal(p.$('folder-new').hidden, false);
  assert.equal(p.$('folder-new-open').attrs['aria-expanded'], 'true');
  assert.equal(focused.at(-1), p.$('folder-new-name'));
  assert.equal(p.$('folder-new-create').disabled, true);
  p.$('folder-new-name').value = '  Alpha <b> & co ';
  p.context.renderFolderBrowser();
  assert.equal(p.$('folder-new-create').disabled, false);
  let prevented = false;
  await p.context.createFolder({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(JSON.parse(JSON.stringify(p.requests.at(-1))), ['POST', '/folders', { path: '/work/space', name: 'Alpha <b> & co' }]);
  assert.equal(p.$('folder-current').textContent, '/work/space/Alpha <b> & co');
  assert.equal(p.$('folder-new').hidden, true);
  assert.equal(p.$('folder-new-open').attrs['aria-expanded'], 'false');
  assert.equal(p.$('folder-status').textContent, 'No folders here.');
  assert.equal(p.$('folder-use').disabled, false);
  p.$('folder-browser').open = true;
  p.context.useBrowsedFolder();
  assert.deepEqual(p.used, ['/work/space/Alpha <b> & co']);
});

test('a refused new folder keeps the form and the current folder and says why', async () => {
  const p = page({ answers: [listing, Object.assign(new Error('beta already exists in /work/space.'), { code: 'folder_exists' })] });
  p.$('folder-browser').open = true;
  await p.context.browseTo('/work/space');
  p.context.showNewFolder(true);
  p.$('folder-new-name').value = 'beta';
  await p.context.createFolder();
  assert.equal(p.$('folder-status').textContent, 'beta already exists in /work/space.');
  assert.equal(p.$('folder-status').classes.has('error'), true);
  assert.equal(p.$('folder-new').hidden, false);
  assert.equal(p.$('folder-current').textContent, '/work/space');
  assert.equal(focused.at(-1), p.$('folder-new-name'));
  p.$('folder-new-name').value = '   ';
  const before = p.requests.length;
  await p.context.createFolder();
  assert.equal(p.requests.length, before);
  let prevented = false;
  p.context.newFolderKeys({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(p.$('folder-new').hidden, true);
  assert.equal(focused.at(-1), p.$('folder-new-open'));
});

test('a new folder is not offered before a listing, and browsing closes the form', async () => {
  const p = page({ answers: [() => new Promise(() => {})] });
  p.$('folder-new').hidden = true;
  p.context.chooseFolder('cwd');
  assert.equal(p.$('folder-new-open').disabled, true);
  const q = page({ answers: [listing, listing] });
  await q.context.browseTo('/work/space');
  q.context.showNewFolder(true);
  q.$('folder-new-name').value = 'x';
  await q.context.browseTo('/work');
  assert.equal(q.$('folder-new').hidden, true);
  assert.deepEqual(q.requests.map((r) => r[0]), ['GET', 'GET']);
});

test('a slower create answer never replaces a newer listing; a sign-in failure leaves for sign-in', async () => {
  let finishCreate;
  const p = page({ answers: [listing, () => new Promise((resolve) => { finishCreate = resolve; }), { ...listing, path: '/work' }] });
  await p.context.browseTo('/work/space');
  p.context.showNewFolder(true);
  p.$('folder-new-name').value = 'slow';
  const creating = p.context.createFolder();
  assert.equal(p.$('folder-new-create').disabled, true);
  assert.equal(p.$('folder-use').disabled, true);
  await p.context.browseTo('/work');
  finishCreate({ ...listing, path: '/work/space/slow' });
  await creating;
  assert.equal(p.$('folder-current').textContent, '/work');
  const signedOut = page({ answers: [listing] });
  signedOut.$('folder-browser').open = true;
  await signedOut.context.browseTo('/work/space');
  signedOut.context.api = async () => { throw new signedOut.context.AuthError('Token rejected'); };
  signedOut.context.showNewFolder(true);
  signedOut.$('folder-new-name').value = 'x';
  await signedOut.context.createFolder();
  assert.deepEqual(signedOut.auth, ['Token rejected']);
  assert.equal(signedOut.$('folder-browser').open, false);
});
