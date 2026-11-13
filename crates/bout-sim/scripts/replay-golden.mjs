// Cross-target determinism check: replay fixtures/golden.json through the wasm build and
// compare state_hash with the native Rust results. Usage: node scripts/replay-golden.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasm = await import(join(root, 'pkg/bout_sim.js'));
wasm.initSync({ module: readFileSync(join(root, 'pkg/bout_sim_bg.wasm')) });

const golden = JSON.parse(readFileSync(join(root, 'fixtures/golden.json'), 'utf8'));
let fail = 0;
const fails = (msg) => { fail++; console.error('FAIL', msg); };

for (const g of golden) {
  const c = JSON.parse(wasm.normalize(JSON.stringify(g.champion)));
  const h = JSON.parse(wasm.normalize(JSON.stringify(g.challenger)));
  if (!c.ok || !h.ok) { fails(`${g.id}: normalize failed ${JSON.stringify([c.error, h.error])}`); continue; }
  const r = JSON.parse(wasm.simulate(JSON.stringify(c.spec), JSON.stringify(h.spec), g.seed, g.rule));
  if (!r.ok) { fails(`${g.id}: simulate ${JSON.stringify(r.error)}`); continue; }
  const f = r.fight;
  const same = f.state_hash === g.state_hash && f.winner === g.winner && f.events.length === g.events
    && f.rounds.length === g.rounds && f.rounds_won[0] === g.rounds_won[0] && f.rounds_won[1] === g.rounds_won[1];
  if (!same) fails(`${g.id}: wasm ${f.state_hash} ${f.winner} ${f.events.length} vs native ${g.state_hash} ${g.winner} ${g.events}`);
  else console.log(`ok   ${g.id.padEnd(24)} ${f.state_hash.slice(0, 16)}  ${f.winner.padEnd(10)} ${f.events.length} events`);
}

// error paths and helpers exposed to the UI
const bad = JSON.parse(wasm.normalize('{"verdict":"refused","name":"x","title":"x","look":"x","cry":"x","school":"BLAZE","style":"BRAWLER","moves":[],"weights":{"power":1,"guard":1,"speed":1,"grit":1}}'));
if (bad.ok || bad.error.code !== 'E_REFUSED') fails('E_REFUSED via wasm');
if (JSON.parse(wasm.normalize('nope')).error.code !== 'E_BAD_JSON') fails('E_BAD_JSON via wasm');
const rb = JSON.parse(wasm.rulebook_json());
if (rb.library.length !== 38 || rb.rules.length !== 8) fails('rulebook_json shape');
const parts = JSON.parse(wasm.request_parts('deepseek-ai/DeepSeek-V3.1'));
const body = parts.prefix + JSON.stringify('say "hi" \\ 🦆').slice(1, -1) + parts.suffix;
if (JSON.parse(body).messages[1].content !== 'Sentence: say "hi" \\ 🦆') fails('request_parts round trip');
if (wasm.build_request('deepseek-ai/DeepSeek-V3.1', 'abc') !== parts.prefix + 'abc' + parts.suffix) fails('build_request');
if (rb.hash !== parts.rulebook_hash) fails('rulebook hash mismatch between exports');

// odds(200) wall time in this wasm build (gate: < 50 ms)
const specs = golden.slice(0, 2).map((g) => JSON.stringify(JSON.parse(wasm.normalize(JSON.stringify(g.champion))).spec));
wasm.odds(specs[0], specs[1], golden[0].seed, 0, 200); // warm-up
const times = [];
for (let i = 0; i < 20; i++) {
  const t = performance.now();
  const o = JSON.parse(wasm.odds(specs[0], specs[1], golden[i % golden.length].seed, i % 8, 200));
  times.push(performance.now() - t);
  if (!o.ok || o.odds.n !== 200) fails('odds shape');
}
times.sort((a, b) => a - b);
console.log(`odds(200) in wasm: median ${times[10].toFixed(2)} ms, max ${times[19].toFixed(2)} ms`);
if (times[19] >= 50) fails(`odds(200) too slow: ${times[19]} ms`);

console.log(fail === 0 ? `PASS: ${golden.length} golden fights identical in wasm` : `FAILED: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
