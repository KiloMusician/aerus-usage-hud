// Verified account snapshots and Ollama totals, kept in the HUD data folder so they survive restarts
// and work offline. Snapshots are only written from a successful live lookup. Nothing is estimated.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readFileWithRetry, withFileLock, writeFileAtomic } from './atomic-write.js';

const VERSION = 1;
const HISTORY_LIMIT = 200;

export function storePath(dataDir) {
  return path.join(dataDir, 'account-snapshots.json');
}

export function emptyStore() {
  return { version: VERSION, current: null, history: [], ollama: null };
}

// Reads the store and says what happened. A missing file is normal first use. A file that exists but cannot
// be used (damaged JSON, a version this build does not know, unreadable) is never silently replaced by an
// empty store: its bytes are first copied to a side file, and if that copy cannot be made the store is
// reported as not writable so the damaged original stays the only copy.
//   problem: null | 'corrupt' | 'unsupported' | 'unreadable'
export async function loadStoreChecked(dataDir) {
  const file = storePath(dataDir);
  let raw;
  try {
    raw = await readFileWithRetry(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { store: emptyStore(), problem: null, writable: true, backup: null };
    return { store: emptyStore(), problem: 'unreadable', writable: false, backup: null };
  }
  let problem = null;
  try {
    const data = JSON.parse(raw.toString('utf8'));
    if (data && data.version === VERSION) return { store: { ...emptyStore(), ...data }, problem: null, writable: true, backup: null };
    problem = 'unsupported';
  } catch {
    problem = 'corrupt';
  }
  // Named after the content so repeated loads of the same damaged file make one copy, not one per refresh.
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const backup = `${path.basename(file)}.${problem}-${digest}`;
  try {
    await fsp.copyFile(file, path.join(dataDir, backup), fsp.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') return { store: emptyStore(), problem, writable: false, backup: null };
  }
  return { store: emptyStore(), problem, writable: true, backup };
}

export async function loadStore(dataDir) {
  return (await loadStoreChecked(dataDir)).store;
}

export async function saveStore(dataDir, store) {
  await writeFileAtomic(storePath(dataDir), JSON.stringify(store, null, 2));
}

// Runs load, change and save as one step so overlapping requests in this process cannot lose each other's
// update. `mutate` returns { changed } (anything else is passed back to the caller untouched).
export function updateStore(dataDir, mutate) {
  return withFileLock(`${storePath(dataDir)}#update`, async () => {
    const loaded = await loadStoreChecked(dataDir);
    const result = (await mutate(loaded.store, loaded)) ?? {};
    if (result.changed && loaded.writable) await saveStore(dataDir, loaded.store);
    return { store: loaded.store, problem: loaded.problem, backup: loaded.backup, writable: loaded.writable, result };
  });
}

// Capture files are rotated and deleted by whatever produces them, so "the sum of the files on disk" can
// fall. The HUD keeps its own ledger of every capture it has seen (id -> tokens), so All Time Ollama usage
// only ever grows and a new capture is always added, even when it is smaller than what was deleted.
//
// store.ollama = { total, observedAt, source, base, captures: { [id]: { tokens, at } } }
//   base      tokens from captures that are no longer listed individually: those folded away after
//             FOLD_AFTER_MS, and, for a store written before the ledger existed, whatever part of the old
//             stored total the files on disk did not explain.
//   captures  every capture seen recently, whether or not its file still exists.
// A store written by an earlier version has only { total, observedAt, source } and is migrated on first use.
const FOLD_AFTER_MS = 30 * 86_400_000;

// `captures` is the list of capture files on disk now: [{ id, tokens, at }]. Returns true if the store changed.
export function recordOllamaCaptures(store, captures, { now = Date.now(), source = 'local Ollama adapter captures' } = {}) {
  const prior = store.ollama;
  const present = new Map();
  for (const capture of captures) {
    const tokens = Math.max(0, Math.round(Number(capture.tokens) || 0));
    if (capture.id && tokens > 0) present.set(capture.id, { tokens, at: Number(capture.at) || now });
  }

  let base;
  const ledger = {};
  if (prior?.captures && typeof prior.captures === 'object') {
    base = Math.max(0, Number(prior.base) || 0);
    Object.assign(ledger, prior.captures);
  } else {
    // Migration: files on disk now are individually accounted for; the rest of the old total becomes the base.
    let onDisk = 0;
    for (const { tokens } of present.values()) onDisk += tokens;
    base = Math.max(0, (Number(prior?.total) || 0) - onDisk);
  }

  for (const [id, { tokens, at }] of present) {
    const known = ledger[id];
    ledger[id] = { tokens: Math.max(known?.tokens ?? 0, tokens), at: known?.at ?? at };
  }
  for (const [id, { tokens, at }] of Object.entries(ledger)) {
    if (!present.has(id) && at < now - FOLD_AFTER_MS) {
      base += tokens;
      delete ledger[id];
    }
  }

  let total = base;
  for (const { tokens } of Object.values(ledger)) total += tokens;
  total = Math.max(total, Number(prior?.total) || 0);

  const unchanged = prior?.captures && prior.total === total && prior.base === base &&
    JSON.stringify(prior.captures) === JSON.stringify(ledger);
  if (unchanged) return false;
  store.ollama = { total, observedAt: new Date(now).toISOString(), source, base, captures: ledger };
  return true;
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
