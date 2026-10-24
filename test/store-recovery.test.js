import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStoreChecked, saveStore, storePath, updateStore, emptyStore } from '../src/account-store.js';
import { scanClaude, LedgerError } from '../src/claude.js';

const temps = [];
after(() => temps.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aerus-store-'));
  temps.push(dir);
  return dir;
};

test('a missing snapshot file is normal first use', async () => {
  const dir = tempDir();
  const loaded = await loadStoreChecked(dir);
  assert.equal(loaded.problem, null);
  assert.equal(loaded.writable, true);
  assert.equal(loaded.backup, null);
});

test('a damaged snapshot file is copied aside byte for byte, once, however many times it is loaded', async () => {
  const dir = tempDir();
  const damaged = '{"version":1,"current":{"lifetimeTokens":9';
  fs.writeFileSync(storePath(dir), damaged);
  const first = await loadStoreChecked(dir);
  const second = await loadStoreChecked(dir);
  assert.equal(first.problem, 'corrupt');
  assert.equal(first.backup, second.backup);
  assert.equal(fs.readFileSync(path.join(dir, first.backup), 'utf8'), damaged);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('corrupt-')).length, 1);
  assert.equal(fs.readFileSync(storePath(dir), 'utf8'), damaged, 'the original is not touched by a load');
});

test('a snapshot file from an unknown version is preserved, not replaced by an empty store', async () => {
  const dir = tempDir();
  const future = JSON.stringify({ version: 2, current: { lifetimeTokens: 123 } });
  fs.writeFileSync(storePath(dir), future);
  const loaded = await loadStoreChecked(dir);
  assert.equal(loaded.problem, 'unsupported');
  assert.equal(fs.readFileSync(path.join(dir, loaded.backup), 'utf8'), future);
});

test('updateStore reports the problem and the next save still succeeds because the bytes were kept', async () => {
  const dir = tempDir();
  fs.writeFileSync(storePath(dir), 'not json');
  const outcome = await updateStore(dir, (store) => {
    store.ollama = { total: 7 };
    return { changed: true };
  });
  assert.equal(outcome.problem, 'corrupt');
  assert.equal(fs.readFileSync(path.join(dir, outcome.backup), 'utf8'), 'not json');
  assert.equal(JSON.parse(fs.readFileSync(storePath(dir), 'utf8')).ollama.total, 7);
});

test('overlapping updateStore calls do not lose each other\'s changes', async () => {
  const dir = tempDir();
  await saveStore(dir, { ...emptyStore(), ollama: { total: 0 } });
  await Promise.all(Array.from({ length: 32 }, () => updateStore(dir, async (store) => {
    const current = store.ollama.total;
    await new Promise((resolve) => setTimeout(resolve, 1));
    store.ollama = { total: current + 1 };
    return { changed: true };
  })));
  assert.equal(JSON.parse(fs.readFileSync(storePath(dir), 'utf8')).ollama.total, 32);
});

test('an unusable Claude ledger raises a typed error and keeps its bytes', async () => {
  const claudeDir = tempDir();
  const dataDir = tempDir();
  const file = path.join(dataDir, 'claude-ledger.json');
  for (const [bytes, kind] of [['{broken', 'corrupt'], [JSON.stringify({ version: 9, records: {} }), 'unsupported'], [JSON.stringify({ version: 1, records: [] }), 'unsupported']]) {
    fs.writeFileSync(file, bytes);
    await assert.rejects(scanClaude({ claudeDir, dataDir }), (error) => error instanceof LedgerError && error.kind === kind);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});
