// Adds and removes the opt-in cards of config/providers.optional.json in the user's providers.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileRevision } from './providers.mjs';
import { readBytes, writeAtomic } from './accounts.mjs';

export const OPTIONAL_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../config/providers.optional.json');

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/**
 * @param {object} opts
 * @param {import('./providers.mjs').ProviderRegistry} opts.registry  reloaded after every change
 * @param {(providerId: string) => boolean} opts.inUse  true while a running session belongs to the card
 */
export function createOptionalCards({ registry, inUse, file = OPTIONAL_FILE }) {
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')).providers;

  function edit(id, revision, change) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw refusal(404, 'unknown_optional_card', `There is no optional card "${id}".`);
    if (revision !== null && typeof revision !== 'string') throw refusal(400, 'bad_revision', 'revision must be a string or null');
    const target = registry.userFile;
    if (!target) throw refusal(409, 'providers_file_unsupported', 'This manager has no providers.json to keep cards in.');
    const bytes = readBytes(target);
    const current = fileRevision(bytes);
    if (revision !== current || registry.revision !== current) {
      if (registry.revision !== current) registry.reload();
      throw refusal(409, 'stale_providers', 'Your tool settings changed elsewhere. Check them and try again.');
    }
    let parsed = { providers: [] };
    if (bytes !== null) {
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch (err) {
        throw refusal(409, 'providers_file_invalid', `${target} is not valid JSON (${err.message}). Fix or remove it, then try again.`);
      }
    }
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? parsed.providers : null;
    if (!Array.isArray(list)) throw refusal(409, 'providers_file_invalid', `${target} has no "providers" list. Fix or remove it, then try again.`);
    const others = list.filter((e) => !(e && typeof e === 'object' && e.id === id));
    const next = change(entry, others);
    if (next.length === list.length && next.every((e, i) => e === list[i])) return;
    if (Array.isArray(parsed)) parsed = next;
    else parsed.providers = next;
    writeAtomic(target, `${JSON.stringify(parsed, null, 2)}\n`);
    registry.reload();
    registry.refreshVersions({ force: true }).catch(() => {});
  }

  return {
    list: () => entries.map((e) => ({ id: e.id, vendor: e.vendor, tool: e.tool, added: Boolean(registry.get(e.id)) })),

    add(id, { revision = null } = {}) {
      edit(id, revision, (entry, others) => [...others, structuredClone(entry)]);
    },

    remove(id, { revision = null } = {}) {
      if (inUse(id)) throw refusal(409, 'card_in_use', 'A session of this card is running. Stop it first.');
      edit(id, revision, (entry, others) => others);
    },
  };
}
