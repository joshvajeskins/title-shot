// Offline verification of vector files with an independent implementation (node + noble).
// usage: node verify-offline.mjs [vector.json ...]   (default: every synthetic-/nearai- vector)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfgOf, verifyForge, jsonEscape } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let files = process.argv.slice(2);
if (!files.length) {
  const d = join(root, 'vectors');
  files = readdirSync(d).filter((n) => /^(synthetic|nearai)-.*\.json$/.test(n)).map((n) => join(d, n));
}
let total = 0, bad = 0;
for (const f of files) {
  const vec = JSON.parse(readFileSync(f, 'utf8'));
  const cfg = cfgOf(vec);
  for (const c of vec.cases) {
    const got = verifyForge(cfg, c);
    total++;
    const want = c.expect;
    if (got.code !== want.code || got.ok !== want.ok || (want.ok && got.content !== want.content)) {
      bad++;
      console.log(`MISMATCH ${f}/${c.name}: node=${got.code} want=${want.code}`);
    }
  }
  for (const e of vec.escape_cases ?? []) {
    total++;
    if (jsonEscape(e.input) !== e.escaped) { bad++; console.log('ESCAPE MISMATCH', JSON.stringify(e.input)); }
  }
  console.log(`${f.split('/').pop()}: ${vec.cases.length} cases checked`);
}
console.log(bad ? `FAIL ${bad}/${total}` : `OK ${total}/${total} agree with the expected table`);
process.exit(bad ? 1 : 0);
