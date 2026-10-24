import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildView } from '../src/aggregate.js';
import { modelBreakdown, UNKNOWN_MODEL, MODEL_CHART_LIMIT } from '../src/models.js';

const NOW = new Date(2026, 9, 23, 15, 0).getTime();
const ev = (provider, model, total, at = NOW - 60_000) => ({
  provider, at, sessionId: `${provider}-${model}`, project: 'p', model,
  input: total, output: 0, cacheRead: 0, cacheWrite: 0, total, cost: 0,
});

test('models from all three providers are included and ranked by total, highest first', () => {
  const result = modelBreakdown([
    ev('codex', 'gpt-5.6-luna', 900),
    ev('claude', 'claude-haiku-5-5', 300),
    ev('ollama', 'qwen2.5-coder:14b', 50),
    ev('codex', 'gpt-6-sol', 400),
    ev('codex', 'gpt-5.6-luna', 100),
  ]);
  assert.deepEqual(
    result.models.map((m) => [m.provider, m.model, m.total]),
    [['codex', 'gpt-5.6-luna', 1000], ['codex', 'gpt-6-sol', 400], ['claude', 'claude-haiku-5-5', 300], ['ollama', 'qwen2.5-coder:14b', 50]],
  );
  assert.equal(result.total, 1750);
});

test('the same model name under two providers stays two separate bars', () => {
  const result = modelBreakdown([ev('codex', 'shared-name', 10), ev('ollama', 'shared-name', 20)]);
  assert.equal(result.models.length, 2);
  assert.deepEqual(result.models.map((m) => m.provider), ['ollama', 'codex']);
});

test('shares add up to 1 and model totals add up to the provider totals (no double counting)', () => {
  const events = [ev('codex', 'a', 300), ev('codex', 'b', 200), ev('claude', 'c', 500), ev('ollama', 'd', 100)];
  const result = modelBreakdown(events);
  const sum = result.models.reduce((s, m) => s + m.total, 0);
  assert.equal(sum, 1100);
  assert.ok(Math.abs(result.models.reduce((s, m) => s + m.share, 0) - 1) < 1e-9);
  const view = buildView({ events, range: 'today', offset: 0, now: NOW });
  assert.equal(view.models.total, view.totals.total);
});

test('a session that reported no model is shown as "Unknown model", never as a real name', () => {
  const result = modelBreakdown([ev('codex', 'unknown', 75), ev('codex', '', 25)]);
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].model, UNKNOWN_MODEL);
  assert.equal(result.models[0].total, 100);
});

test('Today, 7 Days and 30 Days only include usage in their window', () => {
  const yesterday = NOW - 26 * 3_600_000;
  const events = [ev('codex', 'today-model', 100), ev('codex', 'old-model', 900, yesterday)];
  const today = buildView({ events, range: 'today', offset: 0, now: NOW });
  assert.deepEqual(today.models.models.map((m) => m.model), ['today-model']);
  const week = buildView({ events, range: '7d', offset: 0, now: NOW });
  assert.equal(week.models.total, 1000);
});

test('All Time: account-only Codex usage is reported as unattributed and kept out of the chart', () => {
  const events = [ev('codex', 'gpt-5.6-luna', 400), ev('claude', 'claude-haiku-5-5', 100)];
  const allTime = {
    codex: { codexUnique: 1000, localTotal: 400, accountOnly: 600, basis: 'account-snapshot', snapshot: null },
    ollama: { total: 0 },
    lookup: { status: 'current' },
  };
  const view = buildView({ events, range: 'all', offset: 0, now: NOW, allTime });
  assert.equal(view.unattributed, 600);
  assert.equal(view.models.total, 500, 'the chart counts only attributed model usage');
  assert.equal(view.totals.total, 1000 + 100, 'headline totals still include account-only usage');
});

test('more than the chart limit: the rest are grouped into one labelled "Other" bar with their real total', () => {
  const events = [];
  for (let i = 0; i < MODEL_CHART_LIMIT + 3; i += 1) events.push(ev('codex', `m${i}`, 100 - i));
  const result = modelBreakdown(events);
  assert.equal(result.models.length, MODEL_CHART_LIMIT + 1);
  const other = result.models[result.models.length - 1];
  assert.equal(other.provider, 'other');
  assert.equal(other.model, 'Other (3 models)');
  // The grouped models are m12, m13 and m14 (100 - index): 88 + 87 + 86.
  assert.equal(other.total, 88 + 87 + 86);
  assert.equal(result.modelCount, MODEL_CHART_LIMIT + 3);
  assert.equal(result.models.reduce((s, m) => s + m.total, 0), result.total);
});

test('with no usage in the window the breakdown is empty and nothing is invented', () => {
  const view = buildView({ events: [], range: 'today', offset: 0, now: NOW });
  assert.deepEqual(view.models.models, []);
  assert.equal(view.models.total, 0);
  assert.equal(view.unattributed, 0);
});
