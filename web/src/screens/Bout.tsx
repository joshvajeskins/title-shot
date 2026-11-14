import { useCallback, useEffect, useRef, useState } from 'react'
import { sound } from '../audio/sound'
import { Icon } from '../components/Icon'
import { Link } from '../components/Link'
import { Arena } from '../fight/Arena'
import { Forge } from '../fight/Forge'
import { Intro } from '../fight/Intro'
import { Result } from '../fight/Result'
import { GameError } from '../game/client'
import { useGame } from '../game/context'
import type { Belt, Fight, ForgeProgress } from '../game/types'
import { navigate } from '../lib/router'
import { useCompilerMode } from '../game/compiler'

type Phase = 'forge' | 'intro' | 'fight' | 'result' | 'error' | 'loading'

/** /play/bout/:id — id is a belt id while a challenge is pending, else a fight id (replay). */
export function Bout({ beltId: id }: { beltId: string }) {
  const { client, pending, setPending, refreshAccount } = useGame()
  const [phase, setPhase] = useState<Phase>('loading')
  const [fight, setFight] = useState<Fight | null>(null)
  const [belt, setBelt] = useState<Belt | null>(null)
  const [progress, setProgress] = useState<ForgeProgress[]>([])
  const [failed, setFailed] = useState<string | null>(null)
  const [sentence, setSentence] = useState('')
  const started = useRef(false)
  const compiler = useCompilerMode(client.mode)

  const run = useCallback(async (beltId: string, s: string) => {
    setPhase('forge'); setProgress([]); setFailed(null); setSentence(s)
    try {
      setBelt(await client.belt(beltId))
      const f = await client.challenge(beltId, s, (p) => setProgress((list) => [...list, p]))
      setProgress((list) => [...list, { stage: 'done' }])
      setFight(f)
      history.replaceState(null, '', `/play/bout/${f.id}`)
      void refreshAccount()
      setTimeout(() => setPhase('intro'), 900)
    } catch (e) {
      const msg = e instanceof GameError ? e.message : e instanceof Error ? e.message : 'The forge failed.'
      setFailed(msg); sound.play('ui_error')
      void refreshAccount()
    }
  }, [client, refreshAccount])

  useEffect(() => {
    if (started.current) return
    started.current = true
    if (pending && pending.beltId === id) {
      const p = pending
      setPending(null)
      void run(p.beltId, p.sentence)
      return
    }
    client.fight(id).then(async (f) => { setFight(f); setBelt(await client.belt(f.beltId)); setPhase('intro') }, () => setPhase('error'))
  }, [id, pending, setPending, client, run])

  useEffect(() => () => { void sound.music(null) }, [])

  if (phase === 'loading') return <div className="page"><div className="skeleton" style={{ height: '80dvh' }} /></div>
  if (phase === 'error' || (!fight && phase !== 'forge')) {
    return (
      <div className="page"><div className="state-box"><span className="serif-i">No bout here.</span><span>This link points at a bout we can't find on chain.</span><Link href="/play" className="btn btn-ghost btn-sm">Back to the belts</Link></div></div>
    )
  }
  return (
    <>
      {phase !== 'fight' && <Link href="/play" className="bout-exit" aria-label="Leave the bout"><Icon name="x" size={18} /></Link>}
      {phase === 'forge' && (
        <>
          <Forge sentence={sentence} progress={progress} failed={failed} compiler={compiler} />
          {failed && (
            <div className="bout-retry">
              <button className="btn btn-red" onClick={() => { if (belt) void run(belt.id, sentence) }}>Try again</button>
              <button className="btn btn-ghost" onClick={() => navigate(`/play/belt/${belt?.id ?? ''}`)}>Back to my corner</button>
            </div>
          )}
        </>
      )}
      {phase === 'intro' && fight && belt && <Intro fight={fight} beltArt={belt.art} beltName={belt.name} onDone={() => setPhase('fight')} />}
      {phase === 'fight' && fight && <Arena fight={fight} onDone={() => setPhase('result')} />}
      {phase === 'result' && fight && belt && (
        <Result fight={fight} beltArt={belt.art} beltName={belt.name} verified={(fight as Fight & { verified?: boolean }).verified ?? null}
          onRematch={() => { setPending({ beltId: belt.id, sentence: fight.challenger.sentence }); started.current = false; void run(belt.id, fight.challenger.sentence) }}
          onRewrite={() => navigate(`/play/belt/${belt.id}`)} />
      )}
    </>
  )
}
