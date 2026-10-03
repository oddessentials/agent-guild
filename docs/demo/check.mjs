#!/usr/bin/env node
// Fail release CI when the generated demo is incomplete, non-portable, or
// accidentally contains local credentials/state.

import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] || 'docs/.pages');
const required = [
  '.nojekyll', 'index.html', 'app.js', 'theme.js', 'styles.css', 'demo-config.js', 'demo-runtime.js',
  'vendor/xterm/xterm.js', 'vendor/xterm/xterm.css', 'vendor/xterm/addon-fit.js', 'vendor/xterm/addon-web-links.js',
];
const problems = [];
for (const file of required) if (!fs.existsSync(path.join(dir, file))) problems.push(`missing ${file}`);

if (fs.existsSync(path.join(dir, 'index.html'))) {
  const index = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  if (/\b(?:src|href)=["']\//.test(index)) problems.push('index.html contains an origin-root asset URL');
  if (index.indexOf('./demo-runtime.js') > index.indexOf('./app.js')) problems.push('demo runtime does not load before app.js');
  if (!index.includes('./demo-runtime.js')) problems.push('index.html does not load the demo runtime');
}

let bytes = 0;
const walk = (folder) => {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) problems.push(`symbolic link is not allowed: ${path.relative(dir, file)}`);
    else if (entry.isDirectory()) walk(file);
    else {
      const body = fs.readFileSync(file);
      bytes += body.length;
      if (entry.name.endsWith('.css') && /url\(\s*["']?\/(?!\/)/.test(body.toString('utf8'))) {
        problems.push(`${path.relative(dir, file)} contains an origin-root url()`);
      }
      if (/BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/.test(body.toString('utf8'))) {
        problems.push(`possible credential material in ${path.relative(dir, file)}`);
      }
    }
  }
};
if (fs.existsSync(dir)) walk(dir);
if (bytes > 50 * 1024 * 1024) problems.push(`site is ${(bytes / 1024 / 1024).toFixed(1)} MB; limit is 50 MB`);

for (const problem of problems) console.error(`not ok  ${problem}`);
if (problems.length) process.exitCode = 1;
else console.log(`ok  Pages demo: ${required.length} required files, ${(bytes / 1024 / 1024).toFixed(1)} MB`);
