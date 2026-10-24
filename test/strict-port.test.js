import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');

function blockPort() {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', () => resolve({ blocker, port: blocker.address().port }));
  });
}

function startServer(port, extraEnv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aerus-port-'));
  const child = spawn(process.execPath, [SERVER, '--no-open'], {
    env: { ...process.env, PORT: String(port), AERUS_DATA_DIR: path.join(root, 'data'), AERUS_ACCOUNT_LOOKUP: 'off', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = { text: '' };
  child.stdout.on('data', (data) => { log.text += data; });
  child.stderr.on('data', (data) => { log.text += data; });
  return { child, log, root };
}

test('with AERUS_STRICT_PORT the server exits instead of moving to another port', async () => {
  const { blocker, port } = await blockPort();
  const { child, log, root } = startServer(port, { AERUS_STRICT_PORT: '1' });
  try {
    const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => setTimeout(() => reject(new Error(`still running:\n${log.text}`)), 8000))]);
    assert.notEqual(code, 0);
    assert.match(log.text, /EADDRINUSE/);
    assert.ok(!log.text.includes('Dashboard  http://'), 'it never announced an address');
  } finally {
    if (child.exitCode === null) child.kill();
    blocker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('without AERUS_STRICT_PORT the server still falls back to the next free port', async () => {
  const { blocker, port } = await blockPort();
  const { child, log, root } = startServer(port, {});
  try {
    const deadline = Date.now() + 8000;
    while (!log.text.includes('Dashboard  http://') && Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`exited:\n${log.text}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const announced = Number(/Dashboard  http:\/\/127\.0\.0\.1:(\d+)/.exec(log.text)?.[1]);
    assert.ok(announced > port && announced < port + 10, `announced ${announced}`);
  } finally {
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 2000))]);
    blocker.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
