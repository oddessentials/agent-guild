// `agent-guild mcp`'s tools against a real manager in its own data folder, with the fake tool as the session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

test('the MCP tools start, read, type into and stop a real session', { timeout: 30000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-mcp-manager-'));
  const token = '7319ac0e4bd2856f90a3d7c15e8b246dca5f093267e1b804';
  fs.writeFileSync(path.join(home, 'auth-token'), `${token}\n`);
  Object.assign(process.env, { AGENT_GUILD_HOME: home, AGENT_GUILD_PORT: '0', AGENT_GUILD_NO_UPDATE_CHECK: '1', AGENT_GUILD_SKIP_SHELL_ENV: '1' });
  const fixture = fileURLToPath(new URL('./fixtures/fake-tool.mjs', import.meta.url));
  fs.writeFileSync(path.join(home, 'providers.json'), JSON.stringify({ providers: [
    ...['anthropic', 'openai', 'google', 'xai', 'docker', 'shell'].map((id) => ({ id, enabled: false })),
    { id: 'fake', vendor: 'Test', tool: 'Fake Tool', command: process.execPath, args: [fixture], resumeArgs: ['--resume', '{id}'], versionArgs: [fixture, '--version'] },
  ] }));
  const { startManager } = await import('../src/manager/main.mjs');
  const { createGuildClient, serveMcp } = await import('../src/mcp/server.mjs');
  const ctx = await startManager({ sessionDefaults: { killGraceMs: 100 } });
  const input = new PassThrough();
  const output = new PassThrough();
  try {
    const served = serveMcp({ input, output, allowInput: true, client: createGuildClient({ url: ctx.api.url, token: ctx.token }) });
    const waiting = new Map();
    readline.createInterface({ input: output }).on('line', (line) => {
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    });
    let next = 1;
    const call = (name, args = {}) => new Promise((resolve) => {
      const id = next++;
      waiting.set(id, ({ result }) => resolve({ text: result.content[0].text, isError: result.isError === true }));
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
    });
    const until = async (name, args, done) => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const result = await call(name, args);
        if (done(result.text)) return result.text;
        assert.ok(Date.now() < deadline, `${name} never showed what was expected:\n${result.text}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    const { session } = JSON.parse((await call('start_session', { tool: 'fake', cwd: home, resume: 'abc-123' })).text);
    const id = { session_id: session.id };
    await until('read_screen', id, (screen) => screen.includes('FAKE-TOOL READY'));
    assert.equal((await call('send_input', { ...id, text: 'args' })).isError, false);
    await until('read_screen', id, (screen) => screen.includes('ARGS:["--resume","abc-123"]'));
    assert.match((await call('read_reply', id)).text, /no finished reply/);

    assert.equal((await call('stop_session', id)).isError, false);
    await until('list_sessions', {}, (list) => JSON.parse(list).find((s) => s.id === session.id)?.status === 'exited');
    const typed = await call('send_input', { ...id, text: 'echo late' });
    assert.equal(typed.isError, true);
    assert.match(typed.text, /has exited/);
    assert.match((await call('read_screen', id)).text, /FAKE-TOOL READY/);

    // The exited process cannot race these writes. read_screen still goes through
    // the real manager's attach/serializer/WebSocket path and the MCP output boundary.
    const term = ctx.manager.get(session.id).term;
    for (const [cols, discarded] of [[31, 1], [25, 20]]) {
      term.resize(cols, 3);
      term.reset();
      await new Promise((resolve) => term.write(`\x1b[?1049hhttp://127.0.0.1:47821/#token=${token}\r\n$ `, resolve));
      assert.equal(term.buffer.active.type, 'alternate');
      assert.equal(term.buffer.active.length, 3, 'the alternate buffer has no scrollback');
      const visible = Array.from({ length: 2 }, (_, y) => term.buffer.active.getLine(y).translateToString(true)).join('');
      const suffix = token.slice(discarded);
      assert.equal(visible, suffix, 'the token prefix and URL have already been discarded');
      if (cols === 31) assert.equal(suffix.length, 47);
      const screen = (await call('read_screen', id)).text;
      assert.equal(screen.replace(/\s/g, '').includes(suffix), false);
      assert.equal(screen, '[token hidden]\n[token hidden]\n$ ');
    }
    term.resize(80, 3);
    term.reset();
    const ordinary = `color #${token.slice(0, 6)}; rgba ${token.slice(0, 8)}\r\ncommit ${token.slice(0, 7)}; session ${token.slice(0, 12)}\r\n$ `;
    await new Promise((resolve) => term.write(`\x1b[?1049h${ordinary}`, resolve));
    assert.equal((await call('read_screen', id)).text, ordinary.replaceAll('\r\n', '\n'));

    for (const missing of ['deadbeef0000', 'Fix-login']) {
      for (const name of ['read_screen', 'read_reply', 'stop_session']) {
        assert.match((await call(name, { session_id: missing })).text, /No session has the id/, `${name} ${missing}`);
      }
    }
    input.end();
    await served;
  } finally {
    await ctx.shutdown('test done');
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (process.platform === 'win32') setTimeout(() => process.exit(), 3000).unref();
  }
});
