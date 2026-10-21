#!/usr/bin/env node
// The shared/ folder (@wimb/shared) is vendored into BOTH the backend repo and the admin repo, and the
// two copies must stay identical. This compares this repo's shared/ with the one in a sibling checkout:
//   node scripts/check-shared-sync.mjs <path to the other repo>      e.g. ../admin (from the backend repo) or ../backend (from the admin repo)
// Every file is compared except node_modules/, dist/ and *.tsbuildinfo. Exit 0 = identical, 1 = differs.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shared');
const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/check-shared-sync.mjs <path to the other repo (or its shared/ folder)>');
  process.exit(2);
}
let there = path.resolve(arg);
if (existsSync(path.join(there, 'shared', 'package.json'))) there = path.join(there, 'shared');
if (!existsSync(path.join(there, 'package.json'))) {
  console.error(`No shared/ package found at ${there}`);
  process.exit(2);
}

const SKIP = new Set(['node_modules', 'dist', '.DS_Store']);
function list(root, dir = '') {
  const out = [];
  for (const e of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.endsWith('.tsbuildinfo')) continue;
    const rel = path.posix.join(dir.split(path.sep).join('/'), e.name);
    if (e.isDirectory()) out.push(...list(root, rel));
    else if (statSync(path.join(root, rel)).isFile()) out.push(rel);
  }
  return out;
}

const a = new Set(list(here));
const b = new Set(list(there));
const problems = [];
for (const f of a) if (!b.has(f)) problems.push(`only here:  ${f}`);
for (const f of b) if (!a.has(f)) problems.push(`only there: ${f}`);
for (const f of a) {
  if (b.has(f) && !readFileSync(path.join(here, f)).equals(readFileSync(path.join(there, f)))) problems.push(`differs:    ${f}`);
}
if (problems.length) {
  console.error(`shared/ is out of sync with ${there}:\n  ${problems.sort().join('\n  ')}\nCopy the newer folder over the older one (both repos must carry the same shared/).`);
  process.exit(1);
}
console.log(`shared/ is identical to ${there} (${a.size} files).`);
