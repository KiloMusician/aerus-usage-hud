import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyStore, recordOllamaCaptures } from '../src/account-store.js';
import { computeOllamaTotal, ollamaEvents } from '../src/totals.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 24, 12);
const cap = (id, tokens, at = NOW) => ({ id, tokens, at });

// What the All Time view shows for these capture files on disk and this stored ledger.
const shown = (store, onDisk) => computeOllamaTotal({
  events: ollamaEvents(onDisk.map((c) => ({ at: c.at, model: 'm', input: c.tokens, output: 0, total: c.tokens }))),
  stored: store.ollama,
}).total;

test('first sight of captures creates a ledger whose total is their sum', () => {
  const store = emptyStore();
  assert.equal(recordOllamaCaptures(store, [cap('a', 100), cap('b', 50)], { now: NOW }), true);
  assert.equal(store.ollama.total, 150);
  assert.deepEqual(Object.keys(store.ollama.captures).sort(), ['a', 'b']);
});

test('seeing the same captures again changes nothing', () => {
  const store = emptyStore();
  recordOllamaCaptures(store, [cap('a', 100)], { now: NOW });
  const before = JSON.stringify(store);
  assert.equal(recordOllamaCaptures(store, [cap('a', 100)], { now: NOW + 5000 }), false);
  assert.equal(JSON.stringify(store), before);
});

test('rotation: a new capture smaller than the deleted history is still counted', () => {
  const store = emptyStore();
  recordOllamaCaptures(store, [cap('a', 600), cap('b', 400)], { now: NOW });
  assert.equal(store.ollama.total, 1000);
  // The producer deletes both old files and writes one new 300-token response.
  recordOllamaCaptures(store, [cap('c', 300)], { now: NOW + 1000 });
  assert.equal(store.ollama.total, 1300, 'the old "larger of captured and stored" rule would still say 1000');
  assert.equal(shown(store, [cap('c', 300)]), 1300);
});

test('the total never goes down when captures disappear', () => {
  const store = emptyStore();
  recordOllamaCaptures(store, [cap('a', 600)], { now: NOW });
  recordOllamaCaptures(store, [], { now: NOW + 1000 });
  assert.equal(store.ollama.total, 600);
  assert.equal(shown(store, []), 600);
});

test('a store written before the ledger existed migrates without losing or double counting', () => {
  const store = emptyStore();
  store.ollama = { total: 1000, observedAt: '2026-10-01T00:00:00.000Z', source: 'old' };
  // 200 of the old total is explained by files still on disk; 800 is history whose files are gone.
  recordOllamaCaptures(store, [cap('x', 120), cap('y', 80)], { now: NOW });
  assert.equal(store.ollama.base, 800);
  assert.equal(store.ollama.total, 1000, 'migration alone does not change what is shown');
  recordOllamaCaptures(store, [cap('x', 120), cap('y', 80), cap('z', 25)], { now: NOW + 1000 });
  assert.equal(store.ollama.total, 1025);
});

test('migration with more on disk than the old total raises the total to what is on disk', () => {
  const store = emptyStore();
  store.ollama = { total: 100, observedAt: 'x', source: 'old' };
  recordOllamaCaptures(store, [cap('a', 300)], { now: NOW });
  assert.equal(store.ollama.base, 0);
  assert.equal(store.ollama.total, 300);
});

test('a capture that grows while it is being written keeps its largest size', () => {
  const store = emptyStore();
  recordOllamaCaptures(store, [cap('a', 10)], { now: NOW });
  recordOllamaCaptures(store, [cap('a', 90)], { now: NOW + 1000 });
  assert.equal(store.ollama.total, 90);
  recordOllamaCaptures(store, [cap('a', 20)], { now: NOW + 2000 });
  assert.equal(store.ollama.total, 90);
});

test('old captures that are gone are folded into the base so the ledger stays small', () => {
  const store = emptyStore();
  recordOllamaCaptures(store, [cap('old', 500, NOW - 40 * DAY), cap('recent', 70, NOW - DAY)], { now: NOW - 39 * DAY + 2 * DAY });
  // Re-read much later: "old" is 40+ days old and its file is gone, "recent" still exists.
  recordOllamaCaptures(store, [cap('recent', 70, NOW - DAY)], { now: NOW });
  assert.equal(store.ollama.base, 500);
  assert.deepEqual(Object.keys(store.ollama.captures), ['recent']);
  assert.equal(store.ollama.total, 570);
});

test('captures that are still on disk are never folded, however old', () => {
  const store = emptyStore();
  recordOllamaCaptures(store, [cap('ancient', 40, NOW - 400 * DAY)], { now: NOW });
  recordOllamaCaptures(store, [cap('ancient', 40, NOW - 400 * DAY)], { now: NOW + DAY });
  assert.equal(store.ollama.base, 0);
  assert.equal(store.ollama.total, 40);
});

test('zero, negative and anonymous captures are ignored', () => {
  const store = emptyStore();
  recordOllamaCaptures(store, [cap('z', 0), cap('n', -5), { tokens: 10, at: NOW }, cap('ok', 7)], { now: NOW });
  assert.equal(store.ollama.total, 7);
});
