import { useEffect, useMemo, useRef, useState } from 'react'
import { sound } from '../audio/sound'
import { FighterPoster, MoveList, SCHOOL_HINT, SCHOOL_LABEL, StatBars } from '../components/FighterPoster'
import { Icon } from '../components/Icon'
import { Link } from '../components/Link'
import { OddsMeter } from '../components/OddsMeter'
import { TollBreakdown } from '../components/TollBreakdown'
import { cleanSentence, sentenceProblem, type PreviewResult } from '../game/client'
import { useAsync, useGame } from '../game/context'
import { near, plural } from '../lib/format'
import { navigate } from '../lib/router'
import { moveInfo } from '../game/library'
import { useDeployInfo } from '../game/compiler'
import './corner.css'

const IDEAS = ['a pigeon with a law degree', 'a toaster that believes it is a dragon', 'a librarian who bans noise', 'a snail with a rocket backpack', 'a ghost who haunts the DMV', 'the north wind in a bad mood']

export function Corner({ beltId }: { beltId: string }) {
  const { client, account, setPending } = useGame()
  const { data: belt, error, reload } = useAsync(() => client.belt(beltId), [client, beltId])
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewFor, setPreviewFor] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [idea, setIdea] = useState(0)
  const lastKey = useRef(0)
  const deploy = useDeployInfo(client.mode)
  const compiler = deploy.compiler
  const forgeClosed = !deploy.forge.open
  useEffect(() => { void sound.music('lobby_loop') }, [])
  useEffect(() => { const t = setInterval(() => setIdea((i) => (i + 1) % IDEAS.length), 3200); return () => clearInterval(t) }, [])

  const clean = cleanSentence(text)
  const problem = text ? sentenceProblem(text) : null
  const stale = preview && previewFor !== clean
  const odds = useMemo(() => (belt && preview ? client.odds(belt.champion.spec, preview.spec, belt.season.rule?.id ?? 255, 200) : null), [belt, preview, client])
  const toll = belt ? BigInt(belt.tollYocto) : 0n
  const short = account ? BigInt(account.balanceYocto) < toll : false

  const onKey = () => {
    const now = performance.now()
    if (now - lastKey.current > 45) { sound.pick('type_key', 4, { volume: 0.5 }); lastKey.current = now }
  }
  const spar = async () => {
    if (sentenceProblem(text)) return
    setBusy(true); setErr(null); sound.play('paper_whoosh')
    try { const p = await client.preview(clean); setPreview(p); setPreviewFor(clean); sound.play('stamp_slam') }
    catch (e) {
      const code = (e as { code?: string }).code ?? ''
      setErr(code === 'FORGE_CLOSED' || /FORGE_CLOSED/.test(String(e)) ? 'That sentence has not been forged yet, and the forge is closed for today.' : e instanceof Error ? e.message : 'The sparring partner did not show up. Try again.')
      sound.play('ui_error')
    }
    finally { setBusy(false) }
  }
  const challenge = () => {
    if (!belt || sentenceProblem(text)) return
    if (!account) { navigate(`/enter?next=${encodeURIComponent(`/play/belt/${beltId}`)}`); return }
    if (short) { setErr(`You need ${near(belt.tollYocto)} NEAR for the toll.`); return }
    if (cleanSentence(belt.champion.sentence).toLowerCase() === clean.toLowerCase()) { setErr("That's the champion's own sentence. Write a challenger."); return }
    if (forgeClosed && !(preview?.canonical && previewFor === clean)) { setErr('The forge is closed for today, so only sentences that were already forged can fight. Spar to check yours.'); return }
    sound.play('bell_ding')
    setPending({ beltId, sentence: clean })
    navigate(`/play/bout/${beltId}`)
  }

  if (error) return <div className="page"><div className="state-box panel"><span className="serif-i">This belt isn't on the card.</span><span>{error}</span><button className="btn btn-ghost btn-sm" onClick={reload}>Try again</button></div></div>
  if (!belt) return <div className="page"><div className="skeleton" style={{ height: 520 }} /></div>

  const champ = belt.champion
  return (
    <div className={`page corner accent-${belt.accent}`}>
      <div className="corner-top">
        <Link href="/play" className="corner-back"><Icon name="back" size={16} /> The belts</Link>
        <div className="corner-belt"><img src={belt.art} alt="" /><span className="display">{belt.name}</span></div>
      </div>
      <div className="corner-grid">
        <section className="corner-champ" aria-label="The champion">
          <span className="eyebrow">The champion · {plural(belt.defences, 'defence')}</span>
          <div className="corner-champ-row">
            <FighterPoster fighter={champ} corner="champ" size="md" tilt={-2} />
            <div className="corner-champ-detail panel">
              <div className="corner-school"><span className="chip chip-gold">{SCHOOL_LABEL[champ.spec.school]}</span><span className="chip">{champ.spec.style.toLowerCase()}</span></div>
              <p className="corner-hint">{SCHOOL_LABEL[champ.spec.school]} fighters lean on {SCHOOL_HINT[champ.spec.school]}. In the ring, stat points above 20 count half.</p>
              <StatBars spec={champ.spec} compact />
              <MoveList spec={champ.spec} names={moveInfo} />
              <p className="corner-cry serif-i">“{champ.spec.cry}”</p>
            </div>
          </div>
        </section>
        <section className="corner-write" aria-label="Your corner">
          <span className="eyebrow">Your corner</span>
          <h1 className="display print corner-h">Write a challenger</h1>
          <p className="corner-lede">One sentence. The attested AI turns it into a fighter: stats, three moves, a face. Wordsmith against the champion's weak spots.</p>
          {forgeClosed && (
            <div className="forge-closed panel" role="status">
              <Icon name="lock" size={16} />
              <div>
                <b>The forge is closed for today.</b>
                <span>Today's AI budget is spent{deploy.forge.resetsAt ? `; it reopens ${new Date(deploy.forge.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}. Sentences that were already forged still fight: spar to check yours, or rematch a fighter from the Book.</span>
              </div>
            </div>
          )}
          <label className="sheet paper">
            <span className="sr-only">Your sentence</span>
            <textarea
              value={text}
              maxLength={140}
              rows={3}
              spellCheck={false}
              placeholder={IDEAS[idea]}
              onChange={(e) => { setText(e.target.value); setErr(null) }}
              onKeyDown={(e) => { onKey(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void spar() } }}
            />
            <span className={`sheet-count num ${clean.length > 120 ? 'is-over' : ''}`}>{clean.length}/120</span>
          </label>
          {(problem || err) && <p className="corner-err" role="alert"><Icon name="x" size={14} /> {problem ?? err}</p>}
          <div className="corner-actions">
            <button className="btn btn-ghost" disabled={busy || !!problem || !clean} onClick={spar}>
              {busy ? 'Sparring…' : stale || !preview ? 'Spar first · free' : 'Spar again'}
            </button>
            <button className="btn btn-red btn-lg" disabled={busy || !!problem || !clean} onClick={challenge}>
              Challenge · {near(belt.tollYocto)} NEAR
            </button>
          </div>
          {busy && !preview && <FighterPoster sentence={clean} size="md" pending tilt={1.5} />}
          {preview && (
            <div className={`corner-preview ${stale ? 'is-stale' : ''}`}>
              <div className="corner-preview-poster">
                <FighterPoster spec={preview.spec} portrait={preview.portrait} sentence={previewFor} corner="chall" size="md" tilt={2} pending={busy} />
                <span className={`stamp ${preview.canonical ? 'stamp-gold' : ''}`}>{preview.canonical ? 'Forged' : 'Preview'}</span>
              </div>
              <div className="corner-preview-detail">
                {odds && <OddsMeter odds={odds} champName={champ.spec.name} />}
                <StatBars spec={preview.spec} compact />
                <MoveList spec={preview.spec} names={moveInfo} />
                <p className="corner-note">
                  {preview.canonical
                    ? 'This sentence was already forged on chain, so this is exactly the fighter you will get.'
                    : compiler === 'standin'
                      ? 'Staging preview from the labeled stand-in compiler. The paid forge uses the same stand-in until the NEAR AI key lands; the first paid forge of a sentence is final.'
                      : compiler === 'mock'
                        ? 'Offline demo preview. Nothing here touches the chain.'
                        : 'Free preview from the same model and rulebook. The paid forge runs once inside a TEE and is final; at temperature 0 it almost always matches.'}
                </p>
              </div>
            </div>
          )}
          <TollBreakdown tollYocto={belt.tollYocto} champName={champ.spec.name} rule={belt.season.rule} />
        </section>
      </div>
    </div>
  )
}
