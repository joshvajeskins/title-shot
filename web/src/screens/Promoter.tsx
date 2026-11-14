import { useEffect } from 'react'
import { sound } from '../audio/sound'
import { VanceBaseWallet } from '../components/BaseName'
import { Icon } from '../components/Icon'
import { useAsync, useGame } from '../game/context'
import { eth, near, shortHex } from '../lib/format'
import './pages.css'

export function Promoter() {
  const { client } = useGame()
  const { data: belts } = useAsync(() => client.belts(), [client])
  useEffect(() => { const t = setTimeout(() => sound.play('vance_1'), 400); return () => clearTimeout(t) }, [])
  const purseWei = (belts ?? []).reduce((a, b) => a + BigInt(b.season.purse.amountWei), 0n)
  const earned = (belts ?? []).reduce((a, b) => a + BigInt(b.writerEarnedYocto), 0n)
  return (
    <div className="page pages">
      <section className="vance">
        <div className="vance-art"><img src="/art/promoter-vance.webp" alt="Velvet Vance, an AI fight promoter" /></div>
        <div className="vance-copy">
          <span className="eyebrow">The house · an AI agent with its own wallets</span>
          <h1 className="display print page-title">Velvet Vance</h1>
          <p className="page-sub">The promoter is a program, not a person. It writes each season's opening champion with NEAR AI, opens the season on chain, and funds the purse from a Base wallet that is itself a Chain Signatures address of its NEAR account. Its income is the promoter share of every toll, paid in NEAR; on testnet the Base wallet is pre-funded with test ETH because there is no route to swap that income into purses.</p>
          <VanceBaseWallet />
          <button className="btn btn-ghost btn-sm" onClick={() => sound.play(`vance_${1 + Math.floor(Math.random() * 5)}`)}><Icon name="mic" size={16} /> Hear him out</button>
        </div>
      </section>
      <dl className="vance-stats">
        <div className="panel"><dt>Belts promoted</dt><dd className="display num">{belts?.length ?? '–'}</dd></div>
        <div className="panel"><dt>Purses on the line</dt><dd className="display num">{eth(purseWei)} ETH</dd></div>
        <div className="panel"><dt>Champions' writers paid</dt><dd className="display num">{near(earned, 2)} NEAR</dd></div>
        <div className="panel"><dt>Who holds the keys</dt><dd className="display">Nobody</dd></div>
      </dl>
      <section className="vance-belts">
        <h2 className="display sec-h">This season's openers</h2>
        <ul className="opener-list">
          {(belts ?? []).map((b) => (
            <li key={b.id} className="panel">
              <img src={b.art} alt="" />
              <div>
                <b className="display">{b.name}</b>
                <span className="serif-i">Opener: “{b.champion.writer.startsWith('velvet') ? b.champion.sentence : 'taken by a challenger'}”</span>
                <a href={b.season.purse.explorer} target="_blank" rel="noreferrer" className="mono">purse {shortHex(b.season.purse.address)} · {eth(b.season.purse.amountWei)} ETH <Icon name="external" size={11} /></a>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
