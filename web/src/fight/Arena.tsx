import { animate } from 'motion'
import { useEffect, useRef, useState } from 'react'
import { sound } from '../audio/sound'
import { FighterPoster } from '../components/FighterPoster'
import type { Fight, Side } from '../game/types'
import { FX } from '../game/types'
import { actSound, applyFx, Clock, fighterName, fxNames, moveLabel, NO_STATUS, roundVo, schoolOf, type Callout, type Pop, type Status } from './director'
import { Vfx } from './vfx'
import { moveByIndex } from '../game/library'
import './arena.css'

const EASE: [number, number, number, number] = [0.23, 1, 0.32, 1]

export function Arena({ fight, onDone }: { fight: Fight; onDone: () => void }) {
  const stage = useRef<HTMLDivElement>(null)
  const cards = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)]
  const canvas = useRef<HTMLCanvasElement>(null)
  const clock = useRef(new Clock())
  const [maxHp, setMaxHp] = useState<[number, number]>([100, 100])
  const [hp, setHp] = useState<[number, number]>([100, 100])
  const [ghost, setGhost] = useState<[number, number]>([100, 100])
  const [shield, setShield] = useState<[number, number]>([0, 0])
  const [status, setStatus] = useState<[Status, Status]>([NO_STATUS, NO_STATUS])
  const [round, setRound] = useState(0)
  const [wins, setWins] = useState<[number, number]>([0, 0])
  const [banner, setBanner] = useState<{ side: Side; text: string; key: number } | null>(null)
  const [pops, setPops] = useState<Pop[]>([])
  const [callout, setCallout] = useState<Callout>(null)
  const [log, setLog] = useState<string[]>([])
  const [speed, setSpeed] = useState(1)
  const [koSide, setKoSide] = useState<Side | null>(null)
  const [form, setForm] = useState<[number, number] | null>(null)

  const speedRef = useRef(1)
  useEffect(() => { clock.current.speed = speed; speedRef.current = speed }, [speed])

  useEffect(() => {
    const c = clock.current
    c.aborted = false
    const vfx = new Vfx(canvas.current!)
    let popId = 0
    const pop = (side: Side, text: string, kind: Pop['kind']) => {
      const id = ++popId
      setPops((p) => [...p.slice(-5), { id, side, text, kind }])
      setTimeout(() => setPops((p) => p.filter((x) => x.id !== id)), 1100)
    }
    const say = (line: string) => setLog((l) => [...l.slice(-2), line])
    const center = (side: Side) => {
      const el = cards[side].current, st = stage.current
      if (!el || !st) return { x: 0, y: 0 }
      const a = el.getBoundingClientRect(), b = st.getBoundingClientRect()
      return { x: a.left - b.left + a.width / 2, y: a.top - b.top + a.height * 0.4 }
    }
    const finishers = new Set<number>()
    fight.events.forEach((e, i) => {
      if (e.t !== 'round_end' || e.reason !== 'ko') return
      for (let j = i - 1; j >= 0; j--) { const p = fight.events[j]; if (p.t === 'act' || p.t === 'upkeep') { finishers.add(j); break } }
    })
    const flash = (strong: boolean) => {
      const el = stage.current?.querySelector('.arena-flash') as HTMLElement | null
      if (el) animate(el, { opacity: [strong ? 0.85 : 0.5, 0] }, { duration: strong ? 0.5 : 0.22 })
    }
    const run = async () => {
      void sound.music('fight_loop', 900)
      sound.play('crowd_ambience', { volume: 0.35 })
      let idx = -1
      let lastRound = 0
      for (const ev of fight.events) {
        idx++
        const finisher = finishers.has(idx)
        if (finisher) { c.speed = Math.min(c.speed, 1) * 0.45; sound.play('heartbeat_loop', { volume: 0.5 }) }
        switch (ev.t) {
          case 'match_start':
            setMaxHp(ev.max_hp); setHp(ev.max_hp); setGhost(ev.max_hp)
            lastRound = fight.events.filter((e) => e.t === 'round_start').length
            break
          case 'round_start': {
            setRound(ev.round); setStatus([NO_STATUS, NO_STATUS]); setShield([0, 0]); setKoSide(null)
            const mh = fight.events.find((e) => e.t === 'match_start')
            if (mh && mh.t === 'match_start') { setHp(mh.max_hp); setGhost(mh.max_hp) }
            if (ev.form) setForm(ev.form)
            setCallout({ text: ev.round === lastRound && ev.round === 3 ? 'Final round' : `Round ${ev.round}`, kind: 'round' })
            roundVo(ev.round, ev.round === 3)
            await c.wait(ev.round === 1 ? 1150 : 900)
            if (ev.round === 1) { setCallout({ text: 'Fight!', kind: 'fight' }); sound.play('fight'); await c.wait(560) }
            setCallout(null)
            break
          }
          case 'exchange': await c.wait(60); break
          case 'act': {
            const a = ev.actor, f = (1 - a) as Side, dir = a === 0 ? 1 : -1
            const label = moveLabel(fight, a, ev.slot)
            setBanner({ side: a, text: label, key: Math.random() })
            const ae = cards[a].current, fe = cards[f].current
            if (ae) animate(ae, { x: [0, dir * 54, 0], rotate: [0, dir * 3, 0], scale: [1, 1.07, 1] }, { duration: 0.34 / c.speed, ease: EASE })
            await c.wait(170)
            const hitting = ev.outcome === 'hit' || ev.outcome === 'crit' || ev.outcome === 'countered'
            if (ev.outcome === 'crit' || finisher) { await c.wait(150); flash(finisher); if (stage.current) animate(stage.current, { x: [0, -12, 9, -5, 2, 0], y: [0, 7, -4, 2, 0] }, { duration: 0.38 }) }
            const lm = moveByIndex(ev.move_id)
            const mvSchool = lm?.school ?? schoolOf(fight, a)
            actSound(ev, mvSchool)
            const p = center(f)
            if (hitting && ev.dmg > 0) {
              if (fe) { animate(fe, { x: [0, dir * 18, -dir * 8, dir * 3, 0], rotate: [0, dir * 4, 0] }, { duration: 0.34, ease: EASE }); fe.classList.add('is-hit'); setTimeout(() => fe.classList.remove('is-hit'), 130) }
              vfx.burst(p.x, p.y, mvSchool, ev.outcome === 'crit' ? 1.6 : ev.dmg > 40 ? 1.25 : 0.85, dir)
              vfx.burst(p.x, p.y, 'INK', 0.8, dir)
              pop(f, `-${ev.dmg}`, ev.outcome === 'crit' ? 'crit' : 'dmg')
              if (ev.outcome === 'crit') { pop(f, 'Critical!', 'status'); if (Math.random() < 0.45) sound.play(`crit_${1 + Math.floor(Math.random() * 3)}`) }
            } else if (ev.outcome === 'miss') {
              if (fe) animate(fe, { x: [0, dir * 34, 0], rotate: [0, -dir * 7, 0] }, { duration: 0.4, ease: EASE })
              pop(f, 'Miss', 'miss')
            } else if (ev.outcome === 'blocked') {
              pop(f, 'Blocked', 'block'); vfx.burst(p.x, p.y, 'IRON', 0.7, dir)
            } else if (ev.outcome === 'used') {
              if (lm?.kind === 'hex') vfx.burst(p.x, p.y, mvSchool, 0.8, dir)
              else { const me = center(a); vfx.burst(me.x, me.y, mvSchool, 0.7, -dir) }
              if (ev.heal > 0) pop(a, `+${ev.heal}`, 'heal')
            }
            if (ev.recoil > 0) pop(a, `-${ev.recoil}`, 'dmg')
            if (ev.heal > 0 && ev.outcome !== 'used') pop(a, `+${ev.heal}`, 'heal')
            const names = [...fxNames(ev.fx_foe)]
            if (names.length) { pop(f, names[0], 'status'); if (ev.fx_foe & FX.STUN) setTimeout(() => sound.play('stun'), 250) }
            setStatus((s) => { const n: [Status, Status] = [{ ...s[0] }, { ...s[1] }]; n[f] = applyFx(n[f], ev.fx_foe, true); n[a] = applyFx(n[a], ev.fx_self, true); return n })
            setShield(ev.shield); setHp(ev.hp)
            setTimeout(() => setGhost(ev.hp), 450 / c.speed)
            say(`${fighterName(fight, a)} · ${label}${ev.dmg ? ` · ${ev.dmg} dmg` : ev.outcome === 'miss' ? ' · missed' : ''}${ev.outcome === 'crit' ? ' · critical' : ''}`)
            await c.wait(ev.outcome === 'crit' ? 820 : ev.outcome === 'miss' ? 460 : 560)
            break
          }
          case 'skip': {
            const el = cards[ev.actor].current
            if (el) animate(el, { rotate: [0, -4, 4, -3, 0] }, { duration: 0.6 })
            pop(ev.actor, 'Seeing stars', 'status'); sound.play('stun'); if (Math.random() < 0.5) sound.play('vo_stun')
            setStatus((s) => { const n: [Status, Status] = [{ ...s[0] }, { ...s[1] }]; n[ev.actor] = { ...n[ev.actor], stun: false }; return n })
            say(`${fighterName(fight, ev.actor)} is stunned and loses the turn`)
            await c.wait(560)
            break
          }
          case 'upkeep': {
            if (ev.burn > 0) { pop(ev.side, `-${ev.burn}`, 'burn'); sound.play('burn', { volume: 0.6 }) }
            setHp(ev.hp); setTimeout(() => setGhost(ev.hp), 400)
            if (ev.expired) setStatus((s) => { const n: [Status, Status] = [{ ...s[0] }, { ...s[1] }]; n[ev.side] = applyFx(n[ev.side], ev.expired, false); return n })
            await c.wait(ev.burn > 0 ? 380 : 40)
            break
          }
          case 'round_end': {
            setHp(ev.hp); setGhost(ev.hp)
            c.speed = speedRef.current
            if (ev.reason === 'ko') {
              const loser = (1 - ev.winner) as Side
              setKoSide(loser); sound.play('ko_impact'); sound.play('ko'); sound.pick('crowd_roar', 2)
              setCallout({ text: 'Knockout', kind: 'ko' })
              if (stage.current) animate(stage.current, { scale: [1, 1.05, 1] }, { duration: 1.2, ease: EASE })
            } else {
              sound.play('bell_triple')
              setCallout({ text: ev.winner === 2 ? 'Even round' : 'Time · on points', kind: ev.winner === 2 ? 'draw' : 'time' })
            }
            if (ev.winner !== 2) setWins((w) => { const n: [number, number] = [w[0], w[1]]; n[ev.winner as Side]++; return n })
            await c.wait(ev.reason === 'ko' ? 1700 : 1300)
            setCallout(null)
            break
          }
          case 'match_end':
            await c.wait(500)
            break
        }
      }
      onDone()
    }
    run().catch(() => { /* aborted on unmount */ })
    return () => { c.aborted = true; vfx.destroy(); sound.stop('crowd_ambience'); sound.stop('heartbeat_loop') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fight])

  const bar = (side: Side) => (
    <div className={`hpbar hpbar-${side === 0 ? 'champ' : 'chall'}`}>
      <div className="hpbar-name"><span className="display">{fighterName(fight, side)}</span><span className="num">{hp[side]}</span></div>
      <div className="hpbar-track">
        <span className="hpbar-ghost" style={{ transform: `scaleX(${ghost[side] / maxHp[side]})` }} />
        <span className="hpbar-fill" style={{ transform: `scaleX(${hp[side] / maxHp[side]})` }} />
        {shield[side] > 0 && <span className="hpbar-shield" style={{ transform: `scaleX(${Math.min(1, shield[side] / maxHp[side])})` }} />}
      </div>
      <div className="hpbar-status">{(['burn', 'stun', 'weaken', 'haste', 'counter', 'charge'] as const).filter((k) => status[side][k]).map((k) => <span key={k} className={`fxchip fx-${k}`}>{k}</span>)}</div>
    </div>
  )

  return (
    <div className="arena" ref={stage}>
      <div className="arena-bg" aria-hidden="true" />
      <header className="arena-hud">
        {bar(0)}
        <div className="arena-round">
          <span className="eyebrow">Round</span>
          <span className="display num">{round || '–'}</span>
          <div className="arena-pips">{[0, 1].map((s) => <span key={s} className={`pips pips-${s}`}>{[0, 1].map((i) => <i key={i} className={wins[s] > i ? 'is-on' : ''} />)}</span>)}</div>
        </div>
        {bar(1)}
      </header>
      <div className="arena-floor">
        {([0, 1] as Side[]).map((side) => (
          <div key={side} className={`arena-slot arena-slot-${side} ${koSide === side ? 'is-ko' : ''}`}>
            {banner?.side === side && <div key={banner.key} className="move-banner display">{banner.text}</div>}
            <div ref={cards[side]} className="arena-card">
              <FighterPoster fighter={side === 0 ? fight.champion : fight.challenger} corner={side === 0 ? 'champ' : 'chall'} size="lg" tilt={side === 0 ? -2 : 2} showSentence={false} />
            </div>
            <div className="pops">{pops.filter((p) => p.side === side).map((p) => <span key={p.id} className={`pop pop-${p.kind} display`}>{p.text}</span>)}</div>
          </div>
        ))}
      </div>
      <canvas ref={canvas} className="arena-vfx" aria-hidden="true" />
      <div className="arena-flash" aria-hidden="true" />
      <div className="arena-crowd" aria-hidden="true" />
      {form && callout?.kind === 'round' && (
        <div className="form-banner">{([0, 1] as Side[]).map((sd) => <span key={sd} className={form[sd] >= 120 ? 'is-hot' : form[sd] <= 70 ? 'is-cold' : ''}>{fighterName(fight, sd)} {form[sd] >= 120 ? 'is in form' : form[sd] <= 70 ? 'is having an off day' : 'looks steady'} <b className="num">{form[sd]}%</b></span>)}</div>
      )}
      {callout && <div key={callout.text} className={`callout callout-${callout.kind} display print`}>{callout.text}</div>}
      <footer className="arena-foot">
        <div className="arena-log" aria-live="polite">{log.map((l, i) => <span key={i + l}>{l}</span>)}</div>
        <div className="arena-ctrl">
          <button className="btn btn-ghost btn-sm" onClick={() => setSpeed(speed === 1 ? 2 : 1)}>{speed === 1 ? '2× speed' : '1× speed'}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { clock.current.skipping = true }}>Skip</button>
          <a className="btn btn-ghost btn-sm" href="/play">Leave</a>
        </div>
      </footer>
    </div>
  )
}
