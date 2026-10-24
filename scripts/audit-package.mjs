// Release audit: fails if a packaged folder or the tracked source could ship personal usage data,
// credentials, debug symbols, or machine-specific paths. Usage: node scripts/audit-package.mjs [stageDir]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.resolve(process.argv[2] ?? path.join(root, 'packaging', 'stage'));

// File names that hold private usage, transcripts, or credentials.
const FORBIDDEN_NAME = /(snapshot|ledger|\.jsonl$|\.sqlite(-\w+)?$|\.db$|^\.env|auth\.json|credentials|\.pdb$|\.tmp$|\.log$)/i;
// Text that identifies one person's machine or data. Matched case-insensitively in text files.
const FORBIDDEN_TEXT = [
  /killi/i,
  /6,?824,?351,?856/,
  /6,?828,?246,?073/,
  /AI-services/i,
  /OneDrive/i,
  /[A-Z]:\\Users\\/i,
  /\/Users\/[a-z]/i,
];
const TEXT_EXT = /\.(js|mjs|json|html|css|svg|md|txt|ps1|nsi|csproj|cs|bat|cmd)$/i;

const problems = [];

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else visit(full, entry.name);
  }
}

if (!fs.existsSync(stage)) {
  problems.push(`Package folder not found: ${stage}`);
} else {
  walk(stage, (file, name) => {
    if (FORBIDDEN_NAME.test(name)) problems.push(`Private or debug file would ship: ${path.relative(stage, file)}`);
    if (TEXT_EXT.test(name)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const pattern of FORBIDDEN_TEXT) {
        if (pattern.test(text)) problems.push(`Personal text in ${path.relative(stage, file)}: ${pattern}`);
      }
    }
  });
  // The runtime must be present, and the account data folder must not be.
  for (const required of ['server.js', 'runtime/node.exe', 'Aerus AI Usage HUD.exe', 'public/index.html']) {
    if (!fs.existsSync(path.join(stage, required))) problems.push(`Missing required file: ${required}`);
  }
  if (fs.existsSync(path.join(stage, 'data'))) problems.push('A data folder would ship inside the package.');
}

// Tracked source must not contain personal text either.
let tracked = [];
try {
  tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  problems.push('Could not list tracked files (is this a git checkout?).');
}
for (const rel of tracked) {
  if (!TEXT_EXT.test(rel)) continue;
  if (rel === 'scripts/audit-package.mjs' || rel === 'test/compatibility.test.js' || rel === 'test/usage.test.js') continue;
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const pattern of FORBIDDEN_TEXT) {
    if (pattern.test(text)) problems.push(`Personal text in tracked file ${rel}: ${pattern}`);
  }
}

if (problems.length) {
  console.error('AUDIT FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`AUDIT PASSED: ${path.relative(root, stage) || stage} contains no private data, debug symbols, or personal paths.`);
console.log(`Checked ${tracked.length} tracked files and the package folder.`);
