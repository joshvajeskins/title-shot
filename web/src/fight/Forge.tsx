import { useEffect, useState } from 'react'
import { sound } from '../audio/sound'
import { Icon } from '../components/Icon'
import type { ForgeProgress, ForgeStage } from '../game/types'
import './forge.css'

const STEPS: { stage: ForgeStage; title: string; sub: string }[] = [
  { stage: 'toll', title: 'Toll paid', sub: 'From your fight balance with a session key. No wallet popup.' },
  { stage: 'tee', title: 'Sealed forge starts', sub: 'OutLayer runs forge.wasm once, inside an Intel TDX enclave.' },
  { stage: 'compile', title: 'The AI reads your sentence', sub: 'NEAR AI Cloud compiles it under the public rulebook and signs the answer.' },
  { stage: 'verify', title: 'The contract checks the work', sub: 'ecrecover on the AI signature, then the 100-point budget.' },
  { stage: 'fight', title: 'The referee rules', sub: 'Best of three, run inside the NEAR contract with a VRF seed.' },
]
const ORDER: ForgeStage[] = ['toll', 'tee', 'compile', 'verify', 'fight', 'done']

const STANDIN: Partial<Record<ForgeStage, { title: string; sub: string }>> = {
  tee: { title: 'Forge request posted', sub: 'Staging: the relayer picks up the request (the OutLayer enclave runs in production).' },
  compile: { title: 'Stand-in compiler', sub: 'Staging: a labeled stand-in signs the compile until the NEAR AI key lands.' },
  fight: { title: 'The referee rules', sub: 'Best of three inside the NEAR contract. Staging seeds it from the block; production uses the OutLayer VRF.' },
}

// Relayer mode (live on testnet while OutLayer does not return compile runs): same checks in the contract, block seed.
const RELAYER: Partial<Record<ForgeStage, { title: string; sub: string }>> = {
  tee: { title: 'Forge request posted', sub: 'A listed relayer asks NEAR AI to compile. It can deliver the signed answer, never change it.' },
  fight: { title: 'The referee rules', sub: 'Best of three inside the NEAR contract, seeded from the block.' },
}

// Until /api/state says which mode is live, claim neither: no OutLayer copy flashes before the relayer copy.
const NEUTRAL: Partial<Record<ForgeStage, { title: string; sub: string }>> = {
  tee: { title: 'Forge request posted', sub: 'Your challenge is on chain; the AI compile is on its way.' },
  fight: { title: 'The referee rules', sub: 'Best of three, run inside the NEAR contract.' },
}

export function Forge({ sentence, progress, failed, compiler = 'nearai', forgeMode = 'unknown' }: { sentence: string; progress: ForgeProgress[]; failed: string | null; compiler?: string; forgeMode?: string }) {
  const over = compiler === 'standin' ? STANDIN : forgeMode === 'outlayer' ? null : forgeMode === 'relayer' ? RELAYER : NEUTRAL
  const steps = over ? STEPS.map((s) => ({ ...s, ...(over[s.stage] ?? {}) })) : STEPS
  const [typed, setTyped] = useState(0)
  const [start] = useState(Date.now())
  const [now, setNow] = useState(Date.now())
  const current = progress.length ? progress[progress.length - 1].stage : 'toll'
  const idx = ORDER.indexOf(current)
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t) }, [])
  useEffect(() => {
    if (typed >= sentence.length) return
    const t = setTimeout(() => { setTyped((n) => n + 1); if (typed % 2 === 0) sound.pick('type_key', 4, { volume: 0.45 }) }, 38)
    return () => clearTimeout(t)
  }, [typed, sentence])
  useEffect(() => { void sound.music('forge_loop', 500); sound.play('forge_1') }, [])
  useEffect(() => { if (current !== 'toll') sound.play(current === 'fight' ? 'stamp_slam' : 'ui_confirm', { volume: 0.6 }) }, [current])
  const secs = Math.floor((now - start) / 1000)
  return (
    <div className="forge">
      <div className="forge-stage">
        <div className={`forge-press ${current === 'fight' ? 'is-slam' : ''}`}>
          <img src="/art/forge-press.webp" alt="" />
          <div className="forge-glow" />
        </div>
        <div className="forge-strip paper">
          <span className="serif-i">{sentence.slice(0, typed)}<i className="forge-caret" /></span>
        </div>
      </div>
      <section className="forge-steps" aria-live="polite">
        <span className="eyebrow">Forging · {secs}s</span>
        <h1 className="display print forge-h">The forge is lit</h1>
        <ol>
          {steps.map((s, i) => {
            const state = failed && i === Math.max(0, idx) ? 'fail' : i < idx || current === 'done' ? 'done' : i === idx ? 'live' : 'wait'
            const rec = progress.find((p) => p.stage === s.stage)
            return (
              <li key={s.stage} className={`step step-${state}`}>
                <span className="step-dot">{state === 'done' ? <Icon name="check" size={14} stroke={2.6} /> : state === 'fail' ? <Icon name="x" size={14} stroke={2.6} /> : i + 1}</span>
                <div>
                  <b>{s.title}</b>
                  <small>{rec?.note ?? s.sub}</small>
                  {rec?.receipt && rec.receipt.url !== '#' && <a href={rec.receipt.url} target="_blank" rel="noreferrer" className="step-link">receipt <Icon name="external" size={11} /></a>}
                </div>
              </li>
            )
          })}
        </ol>
        {failed && <p className="forge-fail" role="alert">{failed}</p>}
        {!failed && secs > 40 && <p className="forge-slow">The enclave is slow tonight. If the forge times out, your toll comes back minus the forge fee.</p>}
      </section>
    </div>
  )
}
