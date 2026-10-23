import { test } from 'node:test';
import assert from 'node:assert/strict';
import { glassesAddresses, glassesInstallLink } from '../web/glasses-link.js';

test('the install link is the one Meta\'s simulator builds for the glasses page', () => {
  const page = 'https://mini.tail1234.ts.net:8443/glasses.html#token=a1b2';
  // The simulator's "View on Glasses QR" template, for the page at `page`.
  const simulator = `fb-viewapp://web_app_deep_link?appName=${encodeURIComponent('Agent Guild')}&appUrl=${encodeURIComponent(page)}`;
  assert.equal(glassesInstallLink('https://mini.tail1234.ts.net:8443', 'a1b2'), simulator);
  assert.equal(new URL(glassesInstallLink('https://mini.tail1234.ts.net', 'a1b2')).searchParams.get('appUrl'),
    'https://mini.tail1234.ts.net/glasses.html#token=a1b2');
});

test('the install code offers the allowed HTTPS origins, the open page first, then Tailscale', () => {
  const tailscale = { url: 'https://mini.tail1234.ts.net', origins: ['https://mini.tail1234.ts.net'] };
  assert.deepEqual(glassesAddresses(tailscale, 'http://127.0.0.1:8787'), ['https://mini.tail1234.ts.net']);
  const both = { url: 'https://mini.tail1234.ts.net', origins: ['https://guild.example.com', 'https://mini.tail1234.ts.net'] };
  assert.deepEqual(glassesAddresses(both, 'http://127.0.0.1:8787'), ['https://mini.tail1234.ts.net', 'https://guild.example.com']);
  assert.deepEqual(glassesAddresses(both, 'https://guild.example.com'), ['https://guild.example.com', 'https://mini.tail1234.ts.net']);
  const proxy = { url: null, origins: ['http://lan.example.com:8080', 'https://guild.example.com', 'https://alt.example.com'] };
  assert.deepEqual(glassesAddresses(proxy, 'http://127.0.0.1:8787'), ['https://guild.example.com', 'https://alt.example.com']);
  assert.deepEqual(glassesAddresses(proxy, 'https://alt.example.com'), ['https://alt.example.com', 'https://guild.example.com']);
  assert.deepEqual(glassesAddresses(proxy, 'https://not-allowed.example.com'), ['https://guild.example.com', 'https://alt.example.com']);
  assert.deepEqual(glassesAddresses({ url: null, origins: ['http://lan.example.com:8080'] }, 'http://lan.example.com:8080'), []);
  assert.deepEqual(glassesAddresses({ url: null, origins: [] }, 'http://127.0.0.1:8787'), []);
});
