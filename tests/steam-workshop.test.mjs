import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVdf, steamRoots, worldLibrary, createWorkshopFinder } from '../src/manager/steam-workshop.mjs';

const vdf = (libraries) => `"libraryfolders"
{
${libraries.map(([dir, apps], i) => `\t"${i}"
\t{
\t\t"path"\t\t"${dir.replaceAll('\\', '\\\\')}"
\t\t"label"\t\t""
\t\t"apps"
\t\t{
${apps.map((app) => `\t\t\t"${app}"\t\t"1000"`).join('\n')}
\t\t}
\t}`).join('\n')}
}
`;

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-steam-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('Steam’s library list is read, escaped paths included', () => {
  const parsed = parseVdf(vdf([['C:\\Program Files (x86)\\Steam', ['228980']], ['D:\\SteamLibrary', ['5462970', '241100']]]));
  assert.equal(parsed.libraryfolders['1'].path, 'D:\\SteamLibrary');
  assert.deepEqual(Object.keys(parsed.libraryfolders['1'].apps).sort(), ['241100', '5462970']);
  assert.deepEqual(parseVdf('"a" { "b" "c" } }} {'), { a: { b: 'c' } });
});

test('World’s Workshop folder is the one in the library that holds World, and only once it exists', async (t) => {
  const root = setup(t);
  const steam = path.join(root, 'Steam'), other = path.join(root, 'Library two');
  fs.mkdirSync(path.join(steam, 'steamapps'), { recursive: true });
  fs.writeFileSync(path.join(steam, 'steamapps', 'libraryfolders.vdf'), vdf([[steam, ['228980']], [other, ['5462970']]]));
  assert.equal(await worldLibrary({ roots: [path.join(root, 'missing'), steam] }), path.normalize(other));
  const content = path.join(other, 'steamapps', 'workshop', 'content', '5462970');
  let asked = 0;
  const find = createWorkshopFinder({ library: async () => { asked++; return worldLibrary({ roots: [steam] }); } });
  assert.equal(await find(), null, 'no subscriptions yet');
  fs.mkdirSync(content, { recursive: true });
  assert.equal(await find(), content);
  assert.equal(asked, 1, 'where Steam keeps World is looked up once');
});

test('without Steam or World there is no folder, and the next look tries again', async () => {
  let asked = 0;
  const find = createWorkshopFinder({ library: async () => { asked++; return null; } });
  assert.equal(await find(), null);
  assert.equal(await find(), null);
  assert.equal(asked, 2);
  assert.equal(await createWorkshopFinder({ library: async () => { throw new Error('unreadable'); } })(), null);
});

test('Steam is found from the registry on Windows and in its own folders elsewhere', async () => {
  assert.deepEqual(await steamRoots({ platform: 'win32', registry: async () => 'c:/program files (x86)/steam' }), ['c:/program files (x86)/steam']);
  assert.deepEqual(await steamRoots({ platform: 'win32', registry: async () => null }), []);
  assert.deepEqual(await steamRoots({ platform: 'darwin', home: '/Users/me' }), [path.join('/Users/me', 'Library', 'Application Support', 'Steam')]);
  assert.equal((await steamRoots({ platform: 'linux', home: '/home/me' })).length, 3);
});
