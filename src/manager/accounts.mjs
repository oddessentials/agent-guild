// Adds, renames and removes a tool's accounts by editing the user's providers.json.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_ACCOUNT, fileRevision } from './providers.mjs';

export const LABEL_LIMIT = 40;
const ID_LENGTH = 24;

function refusal(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

/** The trimmed label, or a refusal when it is empty, too long, has control characters or names another account. */
export function checkLabel(label, accounts, exceptId = null) {
  if (typeof label !== 'string') throw refusal(400, 'bad_label', 'The account name must be text.');
  const trimmed = label.trim();
  if (!trimmed) throw refusal(400, 'bad_label', 'Enter a name for the account.');
  if (trimmed.length > LABEL_LIMIT) throw refusal(400, 'bad_label', `Use at most ${LABEL_LIMIT} characters.`);
  if (/\p{Cc}/u.test(trimmed)) throw refusal(400, 'bad_label', 'The account name cannot contain control characters.');
  const folded = trimmed.toLocaleLowerCase('en-US');
  if (accounts.some((a) => a.id !== exceptId && a.label.toLocaleLowerCase('en-US') === folded)) {
    throw refusal(409, 'duplicate_label', `There is already an account named ${trimmed}.`);
  }
  return trimmed;
}

/** An id made from the label, unique among `taken`. It names the account's folder, so it never changes after the account is added. */
export function accountIdFor(label, taken) {
  const base = label.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, ID_LENGTH).replace(/-+$/, '') || 'account';
  let id = base;
  for (let n = 2; id === DEFAULT_ACCOUNT || taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

const entryId = (entry) => (typeof entry === 'string' ? entry : entry && typeof entry === 'object' ? String(entry.id ?? '') : '');

/**
 * Applies `change` to the provider's accounts list in the text of providers.json (null when there is no
 * file) and returns the new text. Every other part of the file is kept. A file that cannot be parsed,
 * or accounts set in a way this cannot edit, is refused rather than rewritten.
 */
export function editAccountsText(text, providerId, platform, change, file = 'providers.json') {
  let parsed = { providers: [] };
  if (text !== null) {
    try { parsed = JSON.parse(text); } catch (err) {
      throw refusal(409, 'providers_file_invalid', `${file} is not valid JSON (${err.message}). Fix or remove it, then try again.`);
    }
  }
  const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? parsed.providers : null;
  if (!Array.isArray(list)) throw refusal(409, 'providers_file_invalid', `${file} has no "providers" list. Fix or remove it, then try again.`);
  // Later entries for the same id override earlier ones field by field, so the last one with accounts is in effect.
  const entries = list.filter((entry) => entry && typeof entry === 'object' && entry.id === providerId);
  let entry = entries.findLast((e) => Object.hasOwn(e, 'accounts')) ?? entries.at(-1);
  if (!entry) {
    entry = { id: providerId };
    list.push(entry);
  }
  if (entry[platform] && typeof entry[platform] === 'object' && Object.hasOwn(entry[platform], 'accounts')) {
    throw refusal(409, 'accounts_per_platform', `${file} sets this tool's accounts under "${platform}". Edit them there by hand.`);
  }
  const accounts = entry.accounts ?? [];
  if (!Array.isArray(accounts)) throw refusal(409, 'providers_file_invalid', `${file} has accounts for "${providerId}" that are not a list. Fix them, then try again.`);
  entry.accounts = change(accounts);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function readBytes(file) {
  try { return fs.readFileSync(file); } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw refusal(500, 'providers_file_unreadable', `${file} could not be read: ${err.message}`);
  }
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(next, contents, { flag: 'wx' });
    fs.renameSync(next, file);
  } finally {
    try { fs.unlinkSync(next); } catch { /* renamed, or never created */ }
  }
}

/**
 * @param {object} opts
 * @param {import('./providers.mjs').ProviderRegistry} opts.registry  reloaded after every change
 * @param {(providerId: string, accountId: string) => boolean} opts.inUse  true while a running session uses the account
 */
export function createAccountEditor({ registry, inUse }) {
  // The whole edit is synchronous, so no other request can change the file between the revision check and the write.
  function edit(providerId, revision, apply) {
    const provider = registry.get(providerId);
    if (!provider) throw refusal(404, 'unknown_provider', `unknown provider "${providerId}"`);
    if (!provider.homeVar) throw refusal(409, 'accounts_unsupported', `${provider.tool} keeps a single sign-in.`);
    if (revision !== null && typeof revision !== 'string') throw refusal(400, 'bad_revision', 'revision must be a string or null');
    const file = registry.userFile;
    if (!file) throw refusal(409, 'accounts_unsupported', 'This manager has no providers.json to keep accounts in.');
    const bytes = readBytes(file);
    const current = fileRevision(bytes);
    if (revision !== current || registry.revision !== current) {
      if (registry.revision !== current) registry.reload();
      throw refusal(409, 'stale_accounts', 'The accounts changed elsewhere. Check them and try again.');
    }
    const result = apply(provider, (change) => editAccountsText(bytes === null ? null : bytes.toString('utf8'), providerId, registry.platform, change, file));
    if (result.text !== undefined) {
      writeAtomic(file, result.text);
      registry.reload({ accountsOnly: true });
    }
    return { account: result.account ?? null, dir: result.dir ?? null, changed: result.text !== undefined };
  }

  const known = (provider, accountId) => {
    const account = provider.accounts.find((a) => a.id === accountId);
    if (!account) throw refusal(404, 'unknown_account', `${provider.tool} has no account "${accountId}"`);
    return account;
  };

  return {
    add(providerId, { label, revision = null } = {}) {
      return edit(providerId, revision, (provider, write) => {
        const name = checkLabel(label, provider.accounts);
        let account;
        const text = write((accounts) => {
          const taken = new Set([...provider.accounts.map((a) => a.id), ...accounts.map(entryId)]);
          account = { id: accountIdFor(name, taken), label: name };
          return [...accounts, account];
        });
        return { text, account };
      });
    },

    rename(providerId, accountId, { label, revision = null } = {}) {
      return edit(providerId, revision, (provider, write) => {
        const existing = known(provider, accountId);
        const name = checkLabel(label, provider.accounts, accountId);
        const account = { id: accountId, label: name };
        if (name === existing.label) return { account };
        const text = write((accounts) => {
          const at = accounts.findLastIndex((entry) => entryId(entry) === accountId);
          if (at < 0) return [...accounts, account];
          const entry = accounts[at];
          return accounts.map((item, i) => (i === at ? (typeof entry === 'string' ? account : { ...entry, label: name }) : item));
        });
        return { text, account };
      });
    },

    remove(providerId, accountId, { revision = null } = {}) {
      return edit(providerId, revision, (provider, write) => {
        if (accountId === DEFAULT_ACCOUNT) throw refusal(409, 'default_account', `The default account is ${provider.tool}'s own sign-in and cannot be removed.`);
        const account = known(provider, accountId);
        if (inUse(providerId, accountId)) {
          throw refusal(409, 'account_in_use', `A running session uses the ${account.label} account. Stop it first.`);
        }
        const { dir } = registry.account(provider, accountId);
        const text = write((accounts) => accounts.filter((entry) => entryId(entry) !== accountId));
        return { text, account: { id: account.id, label: account.label }, dir };
      });
    },
  };
}
