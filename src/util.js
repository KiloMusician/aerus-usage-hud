import fsp from 'node:fs/promises';
import path from 'node:path';

export function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Token counters from log files: a negative or non-numeric value is damage, not usage, and counts as 0.
export function tokenCount(value) {
  return Math.max(0, num(value));
}

// Accepts epoch seconds, epoch milliseconds, or an ISO string. Returns epoch ms or null.
export function parseTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    return value < 1e12 ? value * 1000 : value;
  }
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : t;
}

export function normalizeModel(name) {
  return String(name || 'unknown')
    .trim()
    .replace(/^openai\//i, '');
}

// A cwd recorded on Windows (drive letter or backslashes) must be read with Windows rules even when this
// process runs on another OS, and vice versa, so pick the path flavour from the string itself.
const WINDOWS_PATH = /^[A-Za-z]:|\\/;

// True when `child` is `root` itself or below it ('/a/.codex-old' is not inside '/a/.codex').
function isInside(child, root, flavour) {
  const a = child.toLowerCase();
  const b = root.toLowerCase().replace(/[\\/]+$/, '');
  return a === b || a.startsWith(b + flavour.sep);
}

export function projectFromCwd(cwd, root) {
  if (!cwd || typeof cwd !== 'string') return 'Unattributed';
  let decoded = cwd;
  try {
    decoded = decodeURIComponent(cwd);
  } catch {
    decoded = cwd;
  }
  const flavour = WINDOWS_PATH.test(decoded) ? path.win32 : path.posix;
  const normalized = flavour.normalize(decoded);
  if (root && isInside(normalized, flavour.normalize(String(root)), flavour)) return 'Workspace';
  const base = flavour.basename(normalized);
  if (!base || base === '.' || base === flavour.parse(normalized).root) return 'Unattributed';
  return base;
}

export async function isDirectory(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function listJsonl(dir, depth = 0) {
  const found = [];
  if (depth > 8) return found;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await listJsonl(full, depth + 1)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) found.push(full);
  }
  return found;
}
