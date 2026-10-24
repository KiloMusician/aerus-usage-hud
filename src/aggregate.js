// Turns usage events into the view the dashboard draws.
// Every event has: provider ('codex' | 'claude' | 'ollama'), at (epoch ms), sessionId, project, model,
// input, output, cacheRead, cacheWrite, total, cost, and optionally cacheKnown (false when cache is not recorded).
import { modelBreakdown } from './models.js';

const HOUR = 3_600_000;

export const RANGES = ['today', '7d', '30d', 'all'];
export const PROVIDERS = ['codex', 'claude', 'ollama'];

const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const addDays = (ms, days) => {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const dayLabel = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// Window in local time. Offset moves back in steps of one day (Today) or one range (7d, 30d).
export function resolveWindow(range, offset, now = Date.now()) {
  const today = startOfDay(now);
  if (range === 'all') {
    return {
      range,
      offset: 0,
      start: -Infinity,
      end: Infinity,
      canForward: false,
      granularity: 'day',
      seriesStart: addDays(today, -29),
      seriesEnd: addDays(today, 1),
      label: 'All time',
    };
  }
  if (range === 'today') {
    const start = addDays(today, offset);
    return {
      range,
      offset,
      start,
      end: addDays(start, 1),
      canForward: offset < 0,
      granularity: 'hour',
      seriesStart: start,
      seriesEnd: addDays(start, 1),
      label: dayLabel(start),
    };
  }
  const days = range === '30d' ? 30 : 7;
  const end = addDays(today, 1 + offset * days);
  const start = addDays(end, -days);
  return {
    range: days === 30 ? '30d' : '7d',
    offset,
    start,
    end,
    canForward: offset < 0,
    granularity: 'day',
    seriesStart: start,
    seriesEnd: end,
    label: `${dayLabel(start)} – ${dayLabel(addDays(end, -1))}`,
  };
}

function bucketKeys(win) {
  if (win.granularity === 'hour') {
    return Array.from({ length: 24 }, (_, hour) => {
      const d = new Date(win.seriesStart);
      d.setHours(hour, 0, 0, 0);
      return d.getTime();
    });
  }
  const keys = [];
  for (let t = win.seriesStart; t < win.seriesEnd; t = addDays(t, 1)) keys.push(t);
  return keys;
}

const bucketOf = (granularity, at) => (granularity === 'hour' ? new Date(at).setMinutes(0, 0, 0) : startOfDay(at));

const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
const TOKEN_KEYS = Object.keys(blank());

function addInto(target, source) {
  for (const key of TOKEN_KEYS) target[key] += source[key];
  return target;
}

// allTime (All Time only) = { codexUnique, ollama: { total, storedFloorApplied, observedAt }, codex: result of
// computeCodexTotals(), lookup } from totals.js. Those replace the windowed sums for Codex and Ollama totals.
export function buildView({ events, range, offset, now = Date.now(), sources = {}, allTime = null, warnings = [] }) {
  const win = resolveWindow(range, offset, now);
  const keys = bucketKeys(win);
  const slot = new Map(keys.map((key, index) => [key, index]));
  const providers = Object.fromEntries(PROVIDERS.map((p) => [p, blank()]));
  const series = Object.fromEntries(PROVIDERS.map((p) => [p, keys.map(() => 0)]));
  const sessions = new Map();
  const inWindow = events.filter((event) => event.at >= win.start && event.at < win.end);

  for (const event of events) {
    if (event.at < win.start || event.at >= win.end) continue;
    addInto(providers[event.provider], event);

    const index = slot.get(bucketOf(win.granularity, event.at));
    if (index !== undefined) series[event.provider][index] += event.total;

    const key = `${event.provider}:${event.sessionId}`;
    let session = sessions.get(key);
    if (!session) {
      session = { provider: event.provider, sessionId: event.sessionId, project: event.project, model: event.model, lastAt: event.at, cacheKnown: event.cacheKnown !== false, ...blank() };
      sessions.set(key, session);
    }
    if (event.at >= session.lastAt) {
      session.lastAt = event.at;
      session.model = event.model;
      session.project = event.project;
    }
    addInto(session, event);
  }

  // All Time replaces the Codex and Ollama totals with the no-double-count figures.
  if (range === 'all' && allTime) {
    providers.codex.total = allTime.codex.codexUnique;
    providers.ollama.total = Math.max(providers.ollama.total, allTime.ollama.total);
  }

  const sessionRows = [...sessions.values()]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 200)
    .map((s) => ({
      provider: s.provider,
      sessionId: s.sessionId,
      project: s.project,
      model: s.model,
      at: s.lastAt,
      input: s.input,
      output: s.output,
      cache: s.cacheKnown ? s.cacheRead + s.cacheWrite : null,
      total: s.total,
      cost: s.cost,
    }));

  const sessionCounts = Object.fromEntries(PROVIDERS.map((p) => [p, 0]));
  for (const s of sessions.values()) sessionCounts[s.provider] += 1;

  const totals = PROVIDERS.reduce((sum, p) => addInto(sum, providers[p]), blank());
  const share = Object.fromEntries(
    PROVIDERS.map((p) => [p, totals.total ? providers[p].total / totals.total : 0]),
  );

  return {
    generatedAt: now,
    range: win.range,
    offset: win.offset,
    label: win.label,
    canForward: win.canForward,
    totals: { ...totals, sessions: sessions.size },
    providers: Object.fromEntries(
      PROVIDERS.map((p) => [
        p,
        {
          ...providers[p],
          sessions: sessionCounts[p],
          // Ollama captures do not record cache tokens, so cache is reported as unavailable.
          cacheAvailable: p !== 'ollama',
        },
      ]),
    ),
    share,
    // Per-model totals for the Model Proportion chart. Account-only Codex usage has no model, so it is
    // reported here as unattributed and kept out of the chart.
    models: modelBreakdown(inWindow),
    unattributed: range === 'all' && allTime ? allTime.codex.accountOnly : 0,
    series: { granularity: win.granularity, labels: keys, ...series },
    sessions: sessionRows,
    sources,
    allTime: range === 'all' ? allTime : null,
    warnings,
  };
}
