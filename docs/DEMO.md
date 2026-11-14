# Demo film plan (≤ 3:00, 1920×1080, agent-to-agent)

Source footage: screen recordings of the deployed build (agent-browser `record`, 1920×1080), block-explorer cutaways
(nearblocks, basescan), and the game's own audio (ElevenLabs announcer/SFX/music). Assembly: Remotion (titles, captions,
transitions, lower thirds in the Midnight Fight Poster style: Big Shoulders Display / Instrument Serif / JetBrains Mono,
ink #0E0D12, cream #F2E8D5, vermilion #E8402C, brass #E9B949). Narration: plain explaining voice (house rule: full
sentences, "so"/"now" connectors, no taglines), ElevenLabs, separate from the in-game announcer.

| t | Beat | Picture | Sound |
|---|---|---|---|
| 0:00–0:10 | Hook | Typewriter: "a pigeon with a law degree" ⏎ → press slam → poster stamped FORGED → VS Granny Purl ("36 challengers failed · her writer earned 3.5 NEAR") → Serve Subpoena stun → KO → belt lands → bell → basescan line "+ETH, signed by a NEAR contract. Nobody holds this key." | announcer only, no narration |
| 0:10–0:35 | What it is | Corner: champion poster, write a sentence, spar preview, odds meter | VO: one sentence becomes a fighter; you see your odds before you pay |
| 0:35–1:05 | One challenge on chain | Challenge (no popup) → forge steps → receipts drawer: challenge tx, OutLayer attestation, AI signature checked with ecrecover | VO: what the contract checked and why nobody can re-roll |
| 1:05–1:30 | The fight | Arena: moves named after the sentence, crit, KO slow-mo; result: toll split to champion's writer; rematch | announcer + SFX; short VO |
| 1:30–2:00 | The economy | Split bar, Book of bouts, Velvet Vance page (own NEAR account + Chain Signatures Base address) | VO: champion paid for being the target, promoter NPC, no token, closed seasons |
| 2:00–2:30 | The bell | Bell cinematic → close_season tx → sign_payout → basescan payout mined | VO: purse split 50/50 with a 25% cap, signed by MPC for the contract |
| 2:30–2:50 | Proof and limits | Replay hash "matches", SWEEP gates, "what we don't claim" | VO: honest limits |
| 2:50–3:00 | Close | Lobby, URL, repo | music sting |

Footage needed from the live build: one losing challenge, one title change, one draw if it happens, one bell with ≥2
payees and a mined Base payout, the Vance page with real balances. Production (NEAR AI + OutLayer) footage replaces any
staging footage before the final cut; staging footage is never presented as the attested compiler.
