// Record ONE real NEAR AI portrait (FLUX.2-klein) for a recorded compile vector, plus whether it is signed.
//   node scripts/record-portrait.mjs --vector ../../vectors/nearai-real-...-cactus-low.json --slug cactus
// Key from ../../.env.local, never printed. Writes vectors/portrait-<slug>.{png,json}.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d }
const vec = JSON.parse(readFileSync(arg('vector'), 'utf8')), slug = arg('slug', 'p')
const env = Object.fromEntries(readFileSync(new URL('../../../.env.local', import.meta.url), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^"|"$/g, '')]))
const spec = JSON.parse(JSON.parse(vec.response_utf8).choices[0].message.content)
const STYLE = 'Bust portrait, three-quarter view facing right, chest-up, centered, plain flat vermilion background. Bold vintage fight-poster illustration: confident ink linework, flat colour shapes, coarse halftone dot shading, warm paper grain. Limited palette: ink black, cream, vermilion red, brass gold. No text, no letters, no logos.'
const prompt = process.argv.includes('--v2')
  ? `Cartoon mascot character, a single non-human character with its own face, eyes and expressive pose; its whole body IS the subject described here: ${spec.look} No people, no humans, no human faces. ${STYLE}`
  : `${spec.look} ${STYLE}`
const seed = parseInt(createHash('sha256').update(vec.sentence).digest('hex').slice(0, 8), 16)
const body = JSON.stringify({ model: 'black-forest-labs/FLUX.2-klein-4B', prompt, n: 1, size: '768x960', seed, response_format: 'b64_json' })
const t0 = Date.now()
const res = await fetch('https://cloud-api.near.ai/v1/images/generations', { method: 'POST', headers: { authorization: `Bearer ${env.NEARAI_API_KEY}`, 'content-type': 'application/json', 'accept-encoding': 'identity' }, body })
const raw = Buffer.from(await res.arrayBuffer())
const t1 = Date.now()
if (!res.ok) { console.error('HTTP', res.status, raw.toString('utf8').slice(0, 300)); process.exit(1) }
const j = JSON.parse(raw.toString('utf8'))
const b64 = j.data?.[0]?.b64_json
if (b64) writeFileSync(new URL(`../../../vectors/portrait-${slug}.png`, import.meta.url), Buffer.from(b64, 'base64'))
let signature = null
if (j.id) {
  const s = await fetch(`https://cloud-api.near.ai/v1/signature/${encodeURIComponent(j.id)}?model=${encodeURIComponent('black-forest-labs/FLUX.2-klein-4B')}&signing_algo=ecdsa`, { headers: { authorization: `Bearer ${env.NEARAI_API_KEY}` } })
  signature = { status: s.status, body: s.ok ? await s.json() : (await s.text()).slice(0, 200) }
}
const meta = { sentence: vec.sentence, prompt, seed, id: j.id ?? null, keys: Object.keys(j), usage: j.usage ?? null, usd: 0.012, latency_ms: t1 - t0, bytes: b64 ? Buffer.from(b64, 'base64').length : 0, signature }
writeFileSync(new URL(`../../../vectors/portrait-${slug}.json`, import.meta.url), JSON.stringify(meta, null, 1))
console.log(JSON.stringify({ ...meta, prompt: prompt.slice(0, 80) + '…' }, null, 1))
