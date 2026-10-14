#!/usr/bin/env node
// Packs web/yard/assets as the release's art pack and writes web/yard/art.json,
// which the npm package carries in place of the art:
//   node scripts/yard-pack.mjs --out <dir> --url-base https://github.com/<repo>/releases/download/v<version>/
// Unpacks a pack, checked against a manifest, into a folder that must not exist:
//   node scripts/yard-pack.mjs --extract <pack> --manifest <art.json> --into <dir>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentId, extractArchive, listArt, readManifest, writeArchive } from '../src/manager/yard-art.mjs';

const yard = fileURLToPath(new URL('../web/yard/', import.meta.url));
const option = (name) => {
  const at = process.argv.indexOf(name);
  if (at === -1 || !process.argv[at + 1]) return null;
  return process.argv[at + 1];
};

if (option('--extract')) {
  const manifest = readManifest(path.resolve(option('--manifest') ?? path.join(yard, 'art.json')));
  if (!manifest) throw new Error('no manifest');
  const into = path.resolve(option('--into'));
  await extractArchive(path.resolve(option('--extract')), manifest.files, into);
  console.log(`Unpacked ${manifest.files.length} Yard files into ${into}`);
} else {
  const out = path.resolve(option('--out') ?? '.');
  const base = option('--url-base');
  if (!base || !/^https:\/\/.+\/$/.test(base)) throw new Error('--url-base must be an https URL ending in /');
  const assets = path.join(yard, 'assets');
  const files = await listArt(assets);
  const id = contentId(files);
  const name = `yard-art-${id.slice(0, 16)}.tar.gz`;
  fs.mkdirSync(out, { recursive: true });
  const { size, sha256 } = await writeArchive(assets, files, path.join(out, name));
  const manifest = { id, archive: { name, url: base + name, size, sha256 }, files };
  fs.writeFileSync(path.join(yard, 'art.json'), JSON.stringify(manifest) + '\n');
  const mb = (bytes) => (bytes / 1048576).toFixed(1);
  console.log(`Packed ${files.length} Yard files (${mb(files.reduce((sum, file) => sum + file.size, 0))} MB) as ${name} (${mb(size)} MB)`);
}
