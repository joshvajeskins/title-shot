// Independent reference for the contract's json_escape: node JSON.stringify without outer quotes.
// Output is merged into the synthetic vector by it/src/bin/gen_vectors.rs and asserted by a
// native contract unit test (Rust serde_json must equal JS JSON.stringify for every input).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const inputs = [
  '',
  'plain sentence',
  'she said "no" and left',
  'back\\slash and /slash',
  'line1\nline2\r\n\ttabbed',
  'ctrl \u0001 \u001f \u0008 \u000c chars',
  'del \u007f stays raw',
  'emoji \u{1F94A} and \u{1F3C6}',
  '日本語 éè Привет',
  'ls   ps   stay raw',
  '</script><!-- & < > -->',
  'quote\'s and `ticks` and ${tmpl}',
];
const cases = inputs.map((input) => {
  const q = JSON.stringify(input);
  return { input, escaped: q.slice(1, -1) };
});
writeFileSync(join(root, 'vectors', 'escape-cases.json'), JSON.stringify(cases, null, 2) + '\n');
console.log('wrote vectors/escape-cases.json', cases.length, 'cases');
