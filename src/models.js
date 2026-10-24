// Per-model totals for the Model Proportion chart. Read-only: it sums events that were already deduplicated
// by the provider scanners, so a token is never counted twice here. Usage without model identity is not
// given a made-up model name; it is only labelled "Unknown model" when a session reported no model.
const PROVIDERS = ['codex', 'claude', 'ollama'];

export const MODEL_CHART_LIMIT = 12;
export const UNKNOWN_MODEL = 'Unknown model';

export function modelBreakdown(events, { limit = MODEL_CHART_LIMIT } = {}) {
  const byKey = new Map();
  for (const event of events) {
    if (!PROVIDERS.includes(event.provider) || !event.total) continue;
    const name = event.model && event.model !== 'unknown' ? event.model : UNKNOWN_MODEL;
    const key = `${event.provider}\u0000${name}`;
    let row = byKey.get(key);
    if (!row) {
      row = { provider: event.provider, model: name, total: 0 };
      byKey.set(key, row);
    }
    row.total += event.total;
  }

  const ranked = [...byKey.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
  const total = ranked.reduce((sum, row) => sum + row.total, 0);
  const shown = ranked.slice(0, limit);
  const rest = ranked.slice(limit);
  if (rest.length) {
    shown.push({
      provider: 'other',
      model: `Other (${rest.length} models)`,
      total: rest.reduce((sum, row) => sum + row.total, 0),
    });
  }
  return {
    total,
    models: shown.map((row) => ({ ...row, share: total ? row.total / total : 0 })),
    modelCount: ranked.length,
  };
}
