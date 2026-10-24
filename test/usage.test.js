import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCost, claudeRate, codexCost } from '../src/pricing.js';
import { mergeRecord, scanClaude } from '../src/claude.js';
import { scanCodex } from '../src/codex.js';
import { buildView, resolveWindow } from '../src/aggregate.js';
import { computeCodexTotals, computeOllamaTotal, ollamaEvents } from '../src/totals.js';
import { emptyStore, loadStore, recordSnapshot, saveStore } from '../src/account-store.js';

const DAY = 86_400_000;
const temps = [];

after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aerus-${name}-`));
  temps.push(dir);
  return dir;
}

// Reference figures: the Codex account lifetime, the Ollama captures, and the previously verified combined figure.
const ACCOUNT_LIFETIME = 6_824_351_856;
const OLLAMA_TOTAL = 3_894_217;
const PREVIOUS_COMBINED = 6_828_246_073;
const LOCAL_TOTAL = 4_199_634_689;

const codexEvent = (at, total) => ({
  provider: 'codex',
  at,
  sessionId: 's',
  project: 'demo',
  model: 'gpt-5',
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost: 0,
});

const claudeEvent = (at, total) => ({
  provider: 'claude',
  at,
  sessionId: 'c',
  project: 'demo',
  model: 'claude-sonnet-4-5',
  input: total,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total,
  cost: 1,
});

function snapshotAt(store, lifetimeTokens, capturedAt, localTotalAtCapture) {
  const result = recordSnapshot(store, { lifetimeTokens, capturedAt, localTotalAtCapture, source: 'test' });
  assert.equal(result.accepted, true);
  return store;
}

test('Claude pricing: Sonnet input is $3 per million, cache reads are 0.1x, 1h writes 2x', () => {
  assert.equal(claudeRate('claude-sonnet-4-5').input, 3);
  assert.equal(claudeRate('claude-opus-4-1-20250805').output, 75);
  assert.equal(claudeRate('claude-opus-4-6').output, 25);
  assert.equal(claudeCost('claude-sonnet-4-5', { input: 1_000_000, output: 0, cacheRead: 0, cw5m: 0, cw1h: 0 }), 3);
  assert.equal(claudeCost('claude-sonnet-4-5', { input: 0, output: 0, cacheRead: 1_000_000, cw5m: 0, cw1h: 0 }), 0.3);
  assert.equal(claudeCost('claude-sonnet-4-5', { input: 0, output: 0, cacheRead: 0, cw5m: 0, cw1h: 1_000_000 }), 6);
});

test('Codex cost: cached input is priced at the cached rate, not also as fresh input', () => {
  assert.equal(codexCost('gpt-5', { input: 1_000_000, cached: 0, output: 0 }), 1.25);
});

test('mergeRecord keeps the most complete streamed record for a message id', () => {
  const records = {};
  const base = { id: 'm1', at: 1, sessionId: 's', cwd: '', model: 'claude-sonnet-4-5', input: 5, cacheRead: 0, cw5m: 0, cw1h: 0 };
  assert.equal(mergeRecord(records, { ...base, output: 3 }), true);
  assert.equal(mergeRecord(records, { ...base, output: 2 }), false);
  assert.equal(mergeRecord(records, { ...base, output: 40 }), true);
  assert.equal(records.m1.output, 40);
});

test('scanClaude dedupes repeated lines and keeps history after the source is pruned', async () => {
  const claudeDir = tempDir('claude');
  const dataDir = tempDir('data');
  const projectDir = path.join(claudeDir, 'projects', 'C--AI-services');
  fs.mkdirSync(projectDir, { recursive: true });
  const file = path.join(projectDir, 'session-1.jsonl');
  const now = new Date().toISOString();
  const line = (output) =>
    JSON.stringify({
      type: 'assistant',
      sessionId: 'session-1',
      cwd: 'C:\\AI-services\\demo',
      timestamp: now,
      message: {
        id: 'msg_1',
        model: 'claude-opus-4-6',
        usage: { input_tokens: 2, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
      },
    });
  fs.writeFileSync(file, [line(1), line(1), line(337)].join('\n') + '\n');

  const first = await scanClaude({ claudeDir, dataDir });
  assert.equal(first.events.length, 1);
  assert.equal(first.events[0].output, 337);
  assert.equal(first.events[0].total, 2 + 337 + 100 + 50);
  assert.equal(first.events[0].project, 'demo');

  fs.rmSync(file);
  const second = await scanClaude({ claudeDir, dataDir });
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].output, 337);
});

test('scanCodex sums per-turn deltas from token_count events', async () => {
  const codexDir = tempDir('codex');
  const dayDir = path.join(codexDir, 'sessions', '2026', '10', '23');
  fs.mkdirSync(dayDir, { recursive: true });
  const at = new Date().toISOString();
  const lines = [
    { type: 'session_meta', timestamp: at, payload: { id: 'codex-1', cwd: 'C:\\AI-services\\alpha', model: 'gpt-5' } },
    {
      type: 'event_msg',
      timestamp: at,
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, total_tokens: 1200 } } },
    },
    {
      type: 'event_msg',
      timestamp: at,
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 100, total_tokens: 600 } } },
    },
  ];
  fs.writeFileSync(path.join(dayDir, 'rollout-test.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const scan = await scanCodex(codexDir);
  assert.equal(scan.events.length, 2);
  const sum = (key) => scan.events.reduce((total, e) => total + e[key], 0);
  assert.equal(sum('input'), 600 + 500);
  assert.equal(sum('cacheRead'), 400);
  assert.equal(sum('output'), 300);
  assert.equal(scan.events[0].project, 'alpha');
});

test('ollamaEvents turns real capture records into dated events with cache marked unavailable', () => {
  const at = Date.UTC(2026, 8, 20, 19, 36, 30, 854);
  const [event] = ollamaEvents([{ at, model: 'qwen2.5-coder:14b', input: 900, output: 100, total: 1000 }]);
  assert.equal(event.provider, 'ollama');
  assert.equal(event.total, 1000);
  assert.equal(event.model, 'qwen2.5-coder:14b');
  assert.equal(event.cacheKnown, false);
  assert.equal(event.cost, 0);
});

test('resolveWindow: Today offset and 7-day range span the right number of days', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const yesterday = resolveWindow('today', -1, now);
  assert.equal(yesterday.canForward, true);
  assert.equal(yesterday.end - yesterday.start, DAY);
  assert.equal(resolveWindow('today', 0, now).canForward, false);

  const week = resolveWindow('7d', 0, now);
  assert.equal(Math.round((week.end - week.start) / DAY), 7);
  assert.equal(new Date(week.end - 1).getDate(), 23);
});

test('reference numbers: Codex is the account lifetime; Ollama is separate; the previously reported combined total is their sum', () => {
  const capturedAt = '2026-10-23T17:00:00.000Z';
  const store = snapshotAt(emptyStore(), ACCOUNT_LIFETIME, capturedAt, LOCAL_TOTAL);
  const events = [codexEvent(Date.parse(capturedAt) - 3_600_000, LOCAL_TOTAL)];
  const codex = computeCodexTotals({ events, account: store.current });
  const ollama = computeOllamaTotal({ events: [], stored: { total: OLLAMA_TOTAL } });
  assert.equal(codex.localTotal, LOCAL_TOTAL);
  assert.equal(codex.accountOnly, ACCOUNT_LIFETIME - LOCAL_TOTAL);
  assert.equal(codex.codexUnique, ACCOUNT_LIFETIME);
  assert.equal(ollama.total, OLLAMA_TOTAL);
  assert.equal(codex.codexUnique + ollama.total, PREVIOUS_COMBINED);
});

test('a new local session after the snapshot is counted exactly once', () => {
  const capturedAt = '2026-10-23T17:00:00.000Z';
  const store = snapshotAt(emptyStore(), ACCOUNT_LIFETIME, capturedAt, LOCAL_TOTAL);
  const before = Date.parse(capturedAt);
  const events = [codexEvent(before - 3_600_000, LOCAL_TOTAL), codexEvent(before + 60_000, 1_000)];
  const totals = computeCodexTotals({ events, account: store.current });
  assert.equal(totals.codexUnique, ACCOUNT_LIFETIME + 1_000);
  assert.equal(totals.localTotal, LOCAL_TOTAL + 1_000);
  assert.equal(totals.accountOnly, ACCOUNT_LIFETIME - LOCAL_TOTAL);
});

test('repeated refreshes with overlapping records never double count', () => {
  const store = emptyStore();
  const t1 = '2026-10-23T17:00:00.000Z';
  snapshotAt(store, ACCOUNT_LIFETIME, t1, LOCAL_TOTAL);
  const t2 = '2026-10-23T18:00:00.000Z';
  const sessionAt = Date.parse(t1) + 60_000;
  const events = [codexEvent(Date.parse(t1) - 3_600_000, LOCAL_TOTAL), codexEvent(sessionAt, 1_000)];
  snapshotAt(store, ACCOUNT_LIFETIME + 1_000, t2, LOCAL_TOTAL + 1_000);
  const once = computeCodexTotals({ events, account: store.current });
  for (let i = 0; i < 5; i += 1) snapshotAt(store, ACCOUNT_LIFETIME + 1_000, t2, LOCAL_TOTAL + 1_000);
  const again = computeCodexTotals({ events, account: store.current });
  assert.equal(once.codexUnique, ACCOUNT_LIFETIME + 1_000);
  assert.equal(again.codexUnique, once.codexUnique);
});

test('an account total that goes down is rejected and the stored snapshot stays', () => {
  const store = snapshotAt(emptyStore(), ACCOUNT_LIFETIME, '2026-10-23T17:00:00.000Z', LOCAL_TOTAL);
  const result = recordSnapshot(store, { lifetimeTokens: ACCOUNT_LIFETIME - 5, capturedAt: '2026-10-23T18:00:00.000Z', localTotalAtCapture: LOCAL_TOTAL, source: 'test' });
  assert.equal(result.accepted, false);
  assert.equal(store.current.lifetimeTokens, ACCOUNT_LIFETIME);
});

test('without a snapshot Codex is local sessions only, with nothing invented', () => {
  const totals = computeCodexTotals({ events: [codexEvent(Date.now(), 500)], account: null });
  assert.equal(totals.basis, 'local-only');
  assert.equal(totals.accountOnly, 0);
  assert.equal(totals.codexUnique, 500);
  assert.equal(totals.snapshot, null);
});

test('Ollama is a separate source: Codex never includes it', () => {
  const store = snapshotAt(emptyStore(), ACCOUNT_LIFETIME, '2026-10-23T17:00:00.000Z', LOCAL_TOTAL);
  const codex = computeCodexTotals({ events: [], account: store.current });
  assert.equal(codex.codexUnique, ACCOUNT_LIFETIME);
});

test('Ollama history is never lowered when capture files are deleted', () => {
  // The stored total is the verified history. The captures on disk now sum to less.
  const stored = computeOllamaTotal({ events: [], stored: { total: OLLAMA_TOTAL } });
  assert.equal(stored.total, OLLAMA_TOTAL);
  assert.equal(stored.storedFloorApplied, true);
  // Captures that grew past the stored total win.
  const grown = computeOllamaTotal({ events: ollamaEvents([{ at: Date.now(), model: 'm', input: 5_000_000, output: 0, total: 5_000_000 }]), stored: { total: OLLAMA_TOTAL } });
  assert.equal(grown.total, 5_000_000);
  assert.equal(grown.storedFloorApplied, false);
});

test('snapshots persist across a restart (save, then load)', async () => {
  const dataDir = tempDir('store');
  const store = snapshotAt(emptyStore(), ACCOUNT_LIFETIME, '2026-10-23T17:00:00.000Z', LOCAL_TOTAL);
  store.ollama = { total: OLLAMA_TOTAL, observedAt: 'x', source: 'test' };
  await saveStore(dataDir, store);
  const reloaded = await loadStore(dataDir);
  assert.equal(reloaded.current.lifetimeTokens, ACCOUNT_LIFETIME);
  assert.equal(reloaded.current.source, 'test');
  assert.equal(reloaded.ollama.total, OLLAMA_TOTAL);
  assert.equal(reloaded.history.length, 1);
});

test('loadStore starts empty when the file is missing or corrupt', async () => {
  const dataDir = tempDir('corrupt');
  assert.equal((await loadStore(dataDir)).current, null);
  fs.writeFileSync(path.join(dataDir, 'account-snapshots.json'), '{not json');
  assert.equal((await loadStore(dataDir)).current, null);
});

test('buildView All Time: Codex and Ollama stay separate and the grand total is their unique sum', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const local = codexEvent(now - 60_000, 200);
  const claude = claudeEvent(now - 30_000, 300);
  const store = snapshotAt(emptyStore(), 1000, new Date(now - 120_000).toISOString(), 200);
  const ollamaEv = ollamaEvents([{ at: now - 90_000, model: 'qwen', input: 20, output: 10, total: 30 }]);
  const allTime = {
    codex: computeCodexTotals({ events: [local], account: store.current }),
    ollama: computeOllamaTotal({ events: ollamaEv, stored: null }),
    lookup: { status: 'current' },
  };
  const view = buildView({ events: [local, claude, ...ollamaEv], range: 'all', offset: 0, now, allTime });
  // The snapshot (1,000) predates the 200-token session, so the session is added on top: 1,200 Codex.
  assert.equal(view.providers.codex.total, 1200);
  assert.equal(view.providers.ollama.total, 30);
  assert.equal(view.providers.claude.total, 300);
  assert.equal(view.totals.total, 1200 + 300 + 30);
  assert.equal(view.allTime.codex.accountOnly, 1000);
  assert.equal(view.providers.codex.input, 200);
});

test('buildView All Time: a stored Ollama floor raises the Ollama total without touching breakdowns', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const allTime = {
    codex: computeCodexTotals({ events: [], account: null }),
    ollama: computeOllamaTotal({ events: [], stored: { total: OLLAMA_TOTAL } }),
    lookup: { status: 'off' },
  };
  const view = buildView({ events: [], range: 'all', offset: 0, now, allTime });
  assert.equal(view.providers.ollama.total, OLLAMA_TOTAL);
  assert.equal(view.providers.ollama.input, 0);
});

test('buildView marks Ollama cache as unavailable and session cache as null', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const ollamaEv = ollamaEvents([{ at: now - 60_000, model: 'llama3.1:70b', input: 12, output: 7, total: 19 }]);
  const view = buildView({ events: ollamaEv, range: 'today', offset: 0, now });
  assert.equal(view.providers.ollama.cacheAvailable, false);
  assert.equal(view.providers.codex.cacheAvailable, true);
  assert.equal(view.sessions[0].cache, null);
  assert.equal(view.sessions[0].provider, 'ollama');
});

test('buildView windowed views count Ollama captures by their own time and leave Codex as local history', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const view = buildView({
    events: [codexEvent(now - 60_000, 50), ollamaEvents([{ at: now - 60_000, model: 'm', input: 4, output: 6, total: 10 }])[0]],
    range: 'today',
    offset: 0,
    now,
    allTime: { codex: { codexUnique: 999 }, ollama: { total: 999 } },
  });
  assert.equal(view.allTime, null);
  assert.equal(view.providers.codex.total, 50);
  assert.equal(view.providers.ollama.total, 10);
});

test('buildView totals each provider and the shares add up to 1', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime();
  const at = now - 60_000;
  const view = buildView({
    events: [codexEvent(at, 300), claudeEvent(at, 700), ollamaEvents([{ at, model: 'm', input: 500, output: 0, total: 500 }])[0]],
    range: 'today',
    offset: 0,
    now,
  });
  assert.equal(view.providers.codex.total, 300);
  assert.equal(view.providers.claude.total, 700);
  assert.equal(view.providers.ollama.total, 500);
  assert.equal(view.totals.total, 1500);
  assert.equal(view.series.labels.length, 24);
  assert.ok(Math.abs(view.share.codex + view.share.claude + view.share.ollama - 1) < 1e-9);
  assert.equal(view.series.ollama.reduce((a, b) => a + b, 0), 500);
});
