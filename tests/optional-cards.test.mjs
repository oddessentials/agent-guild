import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProviderRegistry } from '../src/manager/providers.mjs';
import { OPTIONAL_FILE, createOptionalCards } from '../src/manager/optional-cards.mjs';

const shipped = JSON.parse(fs.readFileSync(OPTIONAL_FILE, 'utf8')).providers[0];

function setup(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-optional-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const userFile = path.join(dir, 'providers.json');
  if (contents !== undefined) fs.writeFileSync(userFile, typeof contents === 'string' ? contents : JSON.stringify(contents));
  const registry = new ProviderRegistry({ userFile, env: { PATH: '', HOME: dir }, platform: 'linux', checkUpdates: false, accountsDir: path.join(dir, 'accounts') });
  let running = false;
  const cards = createOptionalCards({ registry, inUse: (id) => running && id === shipped.id });
  return { userFile, registry, cards, run: (value) => { running = value; }, read: () => fs.readFileSync(userFile, 'utf8') };
}

const refused = (fn, code) => assert.throws(fn, (err) => err.code === code);

test('an optional card is added to providers.json and removed from it, keeping the other entries', (t) => {
  const fresh = setup(t);
  assert.deepEqual(fresh.cards.list(), [{ id: shipped.id, vendor: shipped.vendor, tool: shipped.tool, added: false }]);
  fresh.cards.add(shipped.id, { revision: null });
  assert.deepEqual(JSON.parse(fresh.read()), { providers: [shipped] });
  assert.equal(fresh.cards.list()[0].added, true);

  const mine = { id: 'shell', enabled: false };
  const existing = setup(t, { providers: [mine, { id: shipped.id, color: '#000000' }] });
  existing.cards.add(shipped.id, { revision: existing.registry.revision });
  assert.deepEqual(JSON.parse(existing.read()).providers, [mine, shipped]);

  existing.run(true);
  refused(() => existing.cards.remove(shipped.id, { revision: existing.registry.revision }), 'card_in_use');
  existing.run(false);
  refused(() => existing.cards.remove(shipped.id, { revision: 'stale' }), 'stale_providers');
  existing.cards.remove(shipped.id, { revision: existing.registry.revision });
  assert.deepEqual(JSON.parse(existing.read()).providers, [mine]);
  assert.equal(existing.registry.get(shipped.id), null);
});

test('a providers.json that is not valid JSON is refused and left exactly as it was', (t) => {
  const broken = setup(t, '{ "providers": [');
  refused(() => broken.cards.add(shipped.id, { revision: broken.registry.revision }), 'providers_file_invalid');
  assert.equal(broken.read(), '{ "providers": [');
});
