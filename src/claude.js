// Claude Code history: ~/.claude/projects/**/*.jsonl (assistant messages carry a usage object).
//
// Two things matter here:
// 1. Claude Code writes several records per API message while it streams. Records are keyed by
//    message.id and only the record with the highest output_tokens is kept, so nothing is double counted.
// 2. Claude Code prunes old transcripts (about 30 days by default). Every message seen is saved to a
//    local ledger in the HUD data folder, so All Time totals keep history after the source is pruned.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { claudeCost } from './pricing.js';
import { isDirectory, listJsonl, normalizeModel, num, parseTime, projectFromCwd } from './util.js';

const LEDGER_VERSION = 1;

export function defaultClaudeDir() {
  return process.env.AERUS_CLAUDE_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Scans run one at a time, so two open tabs cannot write the ledger at the same time.
let queue = Promise.resolve();

export function scanClaude(options) {
  const run = queue.then(() => scanClaudeNow(options));
  queue = run.catch(() => {});
  return run;
}

const fileCache = new Map();

async function scanClaudeNow({ claudeDir = defaultClaudeDir(), dataDir }) {
  const projectsDir = path.join(claudeDir, 'projects');
  const found = await isDirectory(projectsDir);
  const ledgerFile = path.join(dataDir, 'claude-ledger.json');
  const ledger = await loadLedger(ledgerFile);
  const files = found ? await listJsonl(projectsDir) : [];

  let changed = false;
  for (const file of files) {
    for (const rec of await readFileRecords(file)) {
      if (mergeRecord(ledger.records, rec)) changed = true;
    }
  }
  if (changed) await saveLedger(ledgerFile, ledger);

  const events = Object.values(ledger.records).map(toEvent);
  return { found, files: files.length, events, ledgerRecords: events.length };
}

// Returns true when the stored record was added or replaced.
export function mergeRecord(records, rec) {
  const prior = records[rec.id];
  if (prior && prior.output >= rec.output) return false;
  records[rec.id] = {
    id: rec.id,
    at: rec.at,
    sessionId: rec.sessionId,
    cwd: rec.cwd,
    model: rec.model,
    input: rec.input,
    output: rec.output,
    cacheRead: rec.cacheRead,
    cw5m: rec.cw5m,
    cw1h: rec.cw1h,
  };
  return true;
}

export function toEvent(rec) {
  const cacheWrite = rec.cw5m + rec.cw1h;
  return {
    provider: 'claude',
    at: rec.at,
    sessionId: rec.sessionId,
    project: projectFromCwd(rec.cwd),
    model: rec.model,
    input: rec.input,
    output: rec.output,
    cacheRead: rec.cacheRead,
    cacheWrite,
    total: rec.input + rec.output + rec.cacheRead + cacheWrite,
    cost: claudeCost(rec.model, rec),
  };
}

async function readFileRecords(file) {
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return [];
  }
  const key = `${stat.mtimeMs}:${stat.size}`;
  const cached = fileCache.get(file);
  if (cached && cached.key === key) return cached.records;

  const records = [];
  try {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"usage"')) continue;
      let json;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      const rec = usageRecord(json, file);
      if (rec) records.push(rec);
    }
  } catch {
    return [];
  }
  fileCache.set(file, { key, records });
  return records;
}

function usageRecord(json, file) {
  if (json.type !== 'assistant') return null;
  const message = json.message;
  const usage = message?.usage;
  if (!usage || typeof usage !== 'object') return null;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheCreation = num(usage.cache_creation_input_tokens);
  if (!input && !output && !cacheRead && !cacheCreation) return null;
  // The 1-hour split is optional. Anything not marked 1-hour is treated as 5-minute.
  const cw1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  const at = parseTime(json.timestamp);
  const id = message.id || json.uuid;
  if (at == null || !id) return null;
  return {
    id,
    at,
    sessionId: json.sessionId || path.basename(file, '.jsonl'),
    cwd: json.cwd || '',
    model: normalizeModel(message.model),
    input,
    output,
    cacheRead,
    cw5m: Math.max(0, cacheCreation - cw1h),
    cw1h,
  };
}

async function loadLedger(file) {
  let contents;
  try {
    contents = await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { version: LEDGER_VERSION, records: {} };
    throw new Error(`Claude history ledger unreadable at ${file}: ${error.message}`, { cause: error });
  }
  try {
    const data = JSON.parse(contents);
    if (data?.version === LEDGER_VERSION && data.records &&
        typeof data.records === 'object' && !Array.isArray(data.records)) return data;
  } catch (error) {
    throw new Error(`Claude history ledger corrupt at ${file}; original retained`, { cause: error });
  }
  throw new Error(`Unsupported Claude history ledger at ${file}; original retained`);
}

async function saveLedger(file, ledger) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(ledger));
  await fsp.rename(temp, file);
}
