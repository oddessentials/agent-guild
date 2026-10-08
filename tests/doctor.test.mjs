import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { diagnose, formatDiagnostics, runDoctor, checkPortAvailable, managerEnvironment } from '../src/manager/doctor.mjs';
import { VERSION } from '../src/manager/config.mjs';

// Doctor asks the login shell or the registry for PATH like the manager; keep tests to this process's PATH.
process.env.AGENT_GUILD_SKIP_SHELL_ENV = '1';

test('checkPortAvailable returns true for a free port and false for an occupied port', async () => {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const occupiedPort = srv.address().port;

  try {
    const isFree = await checkPortAvailable(occupiedPort, '127.0.0.1');
    assert.equal(isFree, false, 'occupied port should return false');
  } finally {
    srv.close();
  }

  // Find a free port after closing
  const nowFree = await checkPortAvailable(occupiedPort, '127.0.0.1');
  assert.equal(nowFree, true, 'closed port should return true');
});

test('diagnose reports healthy status on a valid environment', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  try {
    const diag = await diagnose({
      nodeVersion: '22.0.0',
      platform: 'darwin',
      arch: 'arm64',
      dir: tempDir,
      port: 59999,
      fetchHealth: async () => null,
      testPortAvailable: async () => true,
      checkPtyProblem: () => null,
      verifyLoadPty: () => ({}),
      tools: [
        { id: 'google', name: 'Antigravity CLI', command: 'agy' },
      ],
    });

    assert.equal(diag.healthy, true);
    assert.equal(diag.fatalIssues.length, 0);
    assert.equal(diag.node.ok, true);
    assert.equal(diag.pty.ok, true);
    assert.equal(diag.storage.writable, true);
    assert.equal(diag.manager.running, false);
    assert.equal(diag.manager.portFree, true);
    assert.equal(diag.manager.portConflict, false);

    const formatted = formatDiagnostics(diag);
    assert.match(formatted, /Agent Guild Doctor/);
    assert.match(formatted, /Node\.js v22\.0\.0/);
    assert.match(formatted, /Terminal subsystem \(node-pty\): functional/);
    assert.match(formatted, /Doctor found no fatal problems/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('diagnose flags unsupported Node.js versions as fatal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  try {
    const diag = await diagnose({
      nodeVersion: '18.19.0',
      dir: tempDir,
      fetchHealth: async () => null,
      testPortAvailable: async () => true,
      checkPtyProblem: () => null,
      verifyLoadPty: () => ({}),
      tools: [],
    });

    assert.equal(diag.healthy, false);
    assert.equal(diag.node.ok, false);
    assert.ok(diag.fatalIssues.some((issue) => issue.includes('Node.js version is below requirement')));

    const formatted = formatDiagnostics(diag);
    assert.match(formatted, /✖ Node\.js v18\.19\.0 \(unsupported/);
    assert.match(formatted, /Doctor found 1 fatal problem/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('diagnose flags pty subsystem problems as fatal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  try {
    const errorMsg = 'Agent Guild needs glibc 2.28 or later on Linux';
    const diag = await diagnose({
      nodeVersion: '22.0.0',
      dir: tempDir,
      fetchHealth: async () => null,
      testPortAvailable: async () => true,
      checkPtyProblem: () => errorMsg,
      tools: [],
    });

    assert.equal(diag.healthy, false);
    assert.equal(diag.pty.ok, false);
    assert.equal(diag.pty.error, errorMsg);
    assert.ok(diag.fatalIssues.some((issue) => issue.includes('glibc 2.28')));

    const formatted = formatDiagnostics(diag);
    assert.match(formatted, /✖ Terminal subsystem \(node-pty\): problem detected/);
    assert.match(formatted, /needs glibc 2\.28/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('diagnose flags port conflicts as fatal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  try {
    const diag = await diagnose({
      nodeVersion: '22.0.0',
      dir: tempDir,
      port: 47821,
      fetchHealth: async () => null,
      testPortAvailable: async () => false, // port occupied by non-manager
      checkPtyProblem: () => null,
      verifyLoadPty: () => ({}),
      tools: [],
    });

    assert.equal(diag.healthy, false);
    assert.equal(diag.manager.running, false);
    assert.equal(diag.manager.portConflict, true);
    assert.ok(diag.fatalIssues.some((issue) => issue.includes('Port 47821 is in use')));

    const formatted = formatDiagnostics(diag);
    assert.match(formatted, /✖ Status: not running, but port 47821 is in use by another process/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('diagnose flags invalid providers.json syntax as fatal', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'providers.json'), '{ invalid json ');
    const diag = await diagnose({
      nodeVersion: '22.0.0',
      dir: tempDir,
      fetchHealth: async () => null,
      testPortAvailable: async () => true,
      checkPtyProblem: () => null,
      verifyLoadPty: () => ({}),
      tools: [],
    });

    assert.equal(diag.healthy, false);
    assert.equal(diag.storage.providersConfig.valid, false);
    assert.ok(diag.fatalIssues.some((issue) => issue.includes('invalid JSON')));

    const formatted = formatDiagnostics(diag);
    assert.match(formatted, /✖ Custom tools \(providers\.json\): invalid syntax/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('diagnose detects running manager and reports version mismatch without failing health', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  try {
    fs.writeFileSync(path.join(tempDir, 'auth-token'), 'dummy-token\n');
    const diag = await diagnose({
      nodeVersion: '22.0.0',
      dir: tempDir,
      port: 47821,
      fetchHealth: async () => ({ name: 'agent-guild', version: '0.99.0', pid: 12345 }),
      testPortAvailable: async () => false,
      checkPtyProblem: () => null,
      verifyLoadPty: () => ({}),
      tools: [],
    });

    assert.equal(diag.healthy, true);
    assert.equal(diag.manager.running, true);
    assert.equal(diag.manager.pid, 12345);
    assert.equal(diag.manager.version, '0.99.0');
    assert.equal(diag.manager.versionMatch, false);

    const formatted = formatDiagnostics(diag);
    assert.match(formatted, /✔ Status: running at/);
    assert.match(formatted, /! Version: running v0\.99\.0, installed/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runDoctor writes formatted output and returns boolean health status', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  try {
    let output = '';
    const ok = await runDoctor({
      nodeVersion: '22.0.0',
      dir: tempDir,
      fetchHealth: async () => null,
      testPortAvailable: async () => true,
      checkPtyProblem: () => null,
      verifyLoadPty: () => ({}),
      tools: [],
      log: (msg) => { output += `${msg}\n`; },
    });

    assert.equal(ok, true);
    assert.match(output, /Agent Guild Doctor/);
    assert.match(output, /Doctor found no fatal problems/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('diagnose shows the version of a working tool and flags one whose version check fails', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  const fakeTool = path.join(import.meta.dirname, 'fixtures', 'fake-tool.mjs');
  try {
    const diag = await diagnose({
      dir: tempDir,
      fetchHealth: async () => null,
      testPortAvailable: async () => true,
      checkPtyProblem: () => null,
      verifyLoadPty: () => ({}),
      tools: [
        { id: 'works', name: 'Works', command: process.execPath, versionArgs: [fakeTool, '--version'] },
        { id: 'broken', name: 'Broken', command: process.execPath, versionArgs: ['-e', "console.error('docker: unknown command: docker agent'); process.exit(1)"] },
      ],
    });

    assert.equal(diag.healthy, true);
    const formatted = formatDiagnostics(diag);
    assert.match(formatted, /✔ Works \(.+\): v1\.2\.3/);
    assert.match(formatted, /! Broken \(.+\): found, but .+ failed: docker: unknown command: docker agent/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('doctor says why the login shell gave no PATH', { skip: process.platform === 'win32' }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  const quits = path.join(tempDir, 'quits');
  fs.writeFileSync(quits, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  try {
    const missing = await managerEnvironment({ env: { SHELL: path.join(tempDir, 'missing'), PATH: '/usr/bin' }, platform: process.platform });
    assert.deepEqual(missing.pathSource, { ok: false, text: `the login shell (${path.join(tempDir, 'missing')}) does not exist; using this terminal's PATH` });
    assert.equal(missing.env.PATH, '/usr/bin');
    const exited = await managerEnvironment({ env: { SHELL: quits, PATH: '/usr/bin' }, platform: process.platform });
    assert.equal(exited.pathSource.text, `the login shell (${quits}) exited with status 3 before reporting its environment; using this terminal's PATH`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

const quiet = { fetchHealth: async () => null, testPortAvailable: async () => true, checkPtyProblem: () => null, verifyLoadPty: () => ({}) };

test('doctor judges tmux as the manager does, so builds from source pass and old ones are flagged', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  const tmux = (output) => ({ id: 'tmux', name: 'tmux', command: process.execPath, versionArgs: ['-e', `console.log(${JSON.stringify(output)})`] });
  try {
    const diag = await diagnose({ ...quiet, dir: tempDir, tools: ['tmux 3.4', 'tmux next-3.5', 'tmux master', 'tmux 3.1', 'tmux next-3.1', '3.4'].map(tmux) });
    const lines = formatDiagnostics(diag).split('\n').filter((line) => line.includes(' tmux ('));
    assert.equal(lines.length, 6);
    assert.match(lines[0], /✔ tmux \(.+\): v3\.4 \(/);
    assert.match(lines[1], /✔ tmux \(.+\): next-3\.5 \(/);
    assert.match(lines[2], /✔ tmux \(.+\): master \(/);
    assert.match(lines[3], /! tmux \(.+\): v3\.1 is too old; 3\.2 or later is required/);
    assert.match(lines[4], /! tmux \(.+\): next-3\.1 is too old; 3\.2 or later is required/);
    assert.match(lines[5], /! tmux \(.+\): found, but its version could not be read/);
    assert.equal(diag.healthy, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('doctor lists a tool that providers.json turns off instead of leaving it out', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-guild-doctor-test-'));
  const builtIn = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'config', 'providers.default.json'), 'utf8')).providers;
  const tools = builtIn.filter((p) => p.command !== '@shell');
  const off = tools.map((p) => ({ id: p.id, enabled: false }));
  const run = async (providers) => {
    fs.writeFileSync(path.join(tempDir, 'providers.json'), JSON.stringify({ providers }));
    return formatDiagnostics(await diagnose({ ...quiet, dir: tempDir }));
  };
  const turnedOff = (name, command) => `  ℹ ${name} (${command}): turned off in providers.json, so not checked`;
  try {
    // Each coding tool off, each multiplexer off on its own, and a tool of the user's own with no versionArgs.
    let out = await run([...off, { id: 'shell', multiplexers: [{ id: 'tmux', enabled: false }, { id: 'herdr', enabled: false }] }, { id: 'mine', tool: 'My Tool', command: process.execPath }]);
    for (const p of tools) assert.ok(out.includes(turnedOff(p.tool, p.command)), `${p.tool} is listed as off:\n${out}`);
    for (const id of ['tmux', 'herdr']) assert.ok(out.includes(turnedOff(id, id)), `${id} is listed as off:\n${out}`);
    assert.match(out, /✔ My Tool \(.+\): found; providers\.json sets no versionArgs, so its version is not checked/);
    // The whole shell provider off takes its multiplexers with it.
    out = await run([...off, { id: 'shell', enabled: false }]);
    for (const id of ['tmux', 'herdr']) assert.ok(out.includes(turnedOff(id, id)), `${id} is listed as off:\n${out}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
