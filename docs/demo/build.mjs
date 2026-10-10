#!/usr/bin/env node
// Assemble the released web client as a static GitHub Pages demo. The output is
// disposable: release CI builds it under docs/.pages and uploads that folder.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');

function option(name, fallback) {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const source = path.resolve(option('--source', path.join(repo, 'web')));
const modules = path.resolve(option('--modules', path.join(repo, 'node_modules')));
const out = path.resolve(option('--out', path.join(repo, 'docs', '.pages')));
const version = option('--version', JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`invalid demo version "${version}"`);
if (!fs.existsSync(path.join(source, 'index.html'))) throw new Error(`web source has no index.html: ${source}`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(source, out, { recursive: true });
// The phone view is not simulated and names its assets from the origin root; the demo is the full page only.
fs.rmSync(path.join(out, 'mobile'), { recursive: true, force: true });

const vendor = {
  'xterm/xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm/xterm.css': '@xterm/xterm/css/xterm.css',
  'xterm/addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'xterm/addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
  'qrcode.mjs': 'qrcode-generator/dist/qrcode.mjs',
};
for (const [target, dependency] of Object.entries(vendor)) {
  const from = path.join(modules, ...dependency.split('/'));
  if (!fs.existsSync(from)) throw new Error(`missing browser dependency: ${from}`);
  const to = path.join(out, 'vendor', ...target.split('/'));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

fs.copyFileSync(path.join(here, 'demo-runtime.js'), path.join(out, 'demo-runtime.js'));
fs.copyFileSync(path.join(here, 'social.png'), path.join(out, 'social.png'));
fs.writeFileSync(path.join(out, 'demo-config.js'), `window.AGENT_GUILD_DEMO_VERSION=${JSON.stringify(version)};\n`);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

const indexFile = path.join(out, 'index.html');
let index = fs.readFileSync(indexFile, 'utf8');
index = index.replace(/((?:src|href)=(["']))\//g, '$1./');
index = index.replace(
  '<script type="module" src="./app.js"></script>',
  '<script src="./demo-config.js"></script>\n  <script src="./demo-runtime.js"></script>\n  <script type="module" src="./app.js"></script>',
);
if (!index.includes('./demo-runtime.js')) throw new Error('could not insert the demo runtime before app.js');
// Link previews need absolute URLs, so these name the published Pages site.
const site = 'https://oddessentials.github.io/agent-guild/';
const summary = 'Try the Agent Guild web client in your browser. The sessions are simulated; nothing runs on your computer.';
index = index.replace('<title>Agent Guild</title>', [
  '<title>Agent Guild</title>',
  `<meta name="description" content="${summary}">`,
  '<meta property="og:type" content="website">',
  '<meta property="og:site_name" content="Agent Guild">',
  '<meta property="og:title" content="Agent Guild">',
  `<meta property="og:description" content="${summary}">`,
  `<meta property="og:url" content="${site}">`,
  `<meta property="og:image" content="${site}social.png">`,
  '<meta property="og:image:width" content="1280">',
  '<meta property="og:image:height" content="640">',
  '<meta property="og:image:alt" content="The Agent Guild crest above the install command, npm install -g @oddessentials/agent-guild, for Windows, macOS and Linux">',
  '<meta name="twitter:card" content="summary_large_image">',
].join('\n  '));
if (!index.includes('og:image')) throw new Error('could not insert the link preview tags after the title');
fs.writeFileSync(indexFile, index);

// Stylesheets name fonts and images from the origin root too; a project page lives below it.
const stylesheets = (folder) => fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
  const file = path.join(folder, entry.name);
  if (entry.isDirectory()) return stylesheets(file);
  return entry.name.endsWith('.css') ? [file] : [];
});
for (const file of stylesheets(out)) {
  const root = path.relative(path.dirname(file), out).split(path.sep).join('/') || '.';
  const css = fs.readFileSync(file, 'utf8');
  const relative = css.replace(/url\(\s*(["']?)\/(?!\/)/g, `url($1${root}/`);
  if (relative !== css) fs.writeFileSync(file, relative);
}

console.log(`Built Agent Guild ${version} Pages demo at ${out}`);
