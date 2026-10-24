// Verified account snapshots and Ollama totals, kept in the HUD data folder so they survive restarts
// and work offline. Snapshots are only written from a successful live lookup. Nothing is estimated.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const VERSION = 1;
const HISTORY_LIMIT = 200;

export function storePath(dataDir) {
  return path.join(dataDir, 'account-snapshots.json');
}

export function emptyStore() {
  return { version: VERSION, current: null, history: [], ollama: null };
}

export async function loadStore(dataDir) {
  try {
    const data = JSON.parse(await fsp.readFile(storePath(dataDir), 'utf8'));
    if (data && data.version === VERSION) return { ...emptyStore(), ...data };
  } catch {
    // Missing or unreadable: start empty. The previous file is left in place until a write succeeds.
  }
  return emptyStore();
}

export async function saveStore(dataDir, store) {
  await fsp.mkdir(dataDir, { recursive: true });
  const file = storePath(dataDir);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fsp.writeFile(temp, JSON.stringify(store, null, 2));
    await fsp.rename(temp, file);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

// Records a successful live lookup. The lifetime total can only stay the same or grow. A lower value is
// rejected and the stored snapshot stays as it was. Every accepted check moves the snapshot forward, so
// the local-after-snapshot calculation always starts from the latest verified point.
export function recordSnapshot(store, { lifetimeTokens, capturedAt, localTotalAtCapture, source }) {
  if (!Number.isFinite(lifetimeTokens) || lifetimeTokens < 0) return { accepted: false, reason: 'Account total was not a valid number.' };
  const prior = store.current;
  if (prior && lifetimeTokens < prior.lifetimeTokens) {
    return { accepted: false, reason: `Account total went down (${lifetimeTokens} < ${prior.lifetimeTokens}); kept the stored snapshot.` };
  }
  const snapshot = {
    lifetimeTokens,
    capturedAt,
    checkedAt: capturedAt,
    localTotalAtCapture,
    source,
  };
  if (!prior || prior.lifetimeTokens !== lifetimeTokens) {
    store.history = [...store.history, { lifetimeTokens, capturedAt, source }].slice(-HISTORY_LIMIT);
  }
  store.current = snapshot;
  return { accepted: true };
}
