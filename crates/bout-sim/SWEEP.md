# bout-sim balance sweep

pool = 40 archetypes + 2000 random valid specs (half uniform, half school-themed) = 2040
part A: each spec vs 300 opponents x 5 seeds x 8 rules = 12000 fights/spec
part B: 1000 random pairs x 25 seeds x 8 rules = 200 fights/pair; counters: top-50 vs whole pool at the same depth
mode: FULL  elapsed: A 16s, B 0s, counters 0s, G9 climb 19s

definitions: win rate = decisive wins / fights (draws count as non-wins), seats alternate; G2 counter = a pool spec with >=55% decisive wins against the target at the part-B depth (first one found); G4 p = (wins + draws/2)/fights per pair, pairs drawn at random from the pool, noise floor shown as the pure-dice null; G6 stun loss = skipped turns / (skipped + acted turns) per fighter per matchup, max over matchups; G7 top 25% = best quarter of the pool by win rate.

## Gates

| gate | requirement | measured | result |
|---|---|---|---|
| G1 | no spec > 65% win rate vs pool | max 59.4% | PASS |
| G2 | every top-50 spec has a counter >= 55% | 50/50 found | PASS |
| G3 | every archetype within 30-70% | 45.3% .. 57.3% | PASS |
| G4 | mean |p-0.5| over random pairs >= 0.12 | 0.149 (pure-dice null 0.028) | PASS |
| G5 | match draw rate 3-12% | 5.0% | PASS |
| G6 | mean exchanges/round 5-10, max stun-turn loss <= 40% | 6.80 ex/round, max stun loss 21.1% | PASS |
| G7 | top-25% has >=80% of moves, all schools, all styles | 38/38 moves, 6/6 schools, 4/4 styles | PASS |
| G8 | events per fight <= 200 | max 147 | PASS |
| G9 | climbed specs re-measured <= 65%, each has a counter >= 55% | top-5 max 61.5% (all finals 61.5%), 5/5 have a counter | PASS |

**ALL GATES PASS**

## G9 adversarial hill-climb

24 restarts x 1200 single-mutation steps (move / weight / school / style), half from random specs and half from the top pool specs; fitness = wins over 128 opponents x 8 rules, redrawn every 60 steps; acceptance on >=.
Selection: the 5 best distinct finals on a separate 200 opponents x 3 seeds x 8 rules sample. Re-measure: fresh seeds (new salt) and a fresh sample of 300 opponents x 5 seeds x 8 rules = 12000 fights each (G1's definition: decisive wins / fights).
Counter: a pool spec with >= 55% decisive wins against the climbed spec at part-B depth (200 fights) that also scores >= 55% at 4x depth on other seeds (first one found).

| # | climbed spec | selection | fresh G1 | pool counter (part-B depth) | same counter at 4x depth |
|---|---|---|---|---|---|
| 1 | TIDE SHOWBOAT ["thorn_wall", "flame_lash", "undertow"] stats [8, 22, 22, 22] | 61.6% | 60.9% | pool#9 63.5% | 59.7% |
| 2 | MIND COUNTERPUNCHER ["psy_siphon", "tidal_wall", "pounce"] stats [18, 24, 18, 14] | 61.1% | 58.3% | pool#1 62.5% | 63.5% |
| 3 | MIND TACTICIAN ["psy_siphon", "thorn_wall", "pounce"] stats [18, 20, 19, 14] | 61.1% | 61.5% | pool#1 60.5% | 63.5% |
| 4 | MIND TACTICIAN ["psy_siphon", "flame_lash", "bulwark"] stats [9, 22, 22, 22] | 60.3% | 59.9% | pool#1 65.5% | 66.5% |
| 5 | MIND TACTICIAN ["flame_lash", "psy_siphon", "thorn_wall"] stats [11, 20, 22, 19] | 60.3% | 60.3% | pool#1 61.5% | 57.6% |

known exploits from earlier audits, re-measured on fresh seeds and opponents (gated too):
- MIND SHOWBOAT ["hex_gaze", "smolder", "brain_freeze"] stats [9, 8, 39, 22] : 54.5%
- VOLT SHOWBOAT ["chain_shock", "overclock", "thunderclap"] stats [8, 8, 36, 15] : 51.5%
- IRON SHOWBOAT ["rivet_barrage", "focus", "overclock"] stats [9, 9, 8, 42] : 47.6%
- BLAZE SHOWBOAT ["melt_through", "battle_roar", "rivet_barrage"] stats [21, 13, 29, 9] : 53.6%
- MIND SHOWBOAT ["foresight", "psy_siphon", "bulwark"] stats [19, 19, 19, 19] : 60.1%

all 24 climbed finals, fresh G1 (diagnostic, not gated): max 61.5%  [61.1% 57.2% 59.9% 58.3% 59.2% 58.9% 60.3% 60.4% 58.5% 57.5% 58.2% 61.5% 61.3% 57.2% 60.9% 58.7% 58.7% 61.4% 59.9% 59.0% 55.7% 60.1% 57.3% 60.8%]

most common moves in the climbed finals: thorn_wall 9, flame_lash 6, dent 6, psy_siphon 6, fire_whirl 4, brain_freeze 4, wave_slap 3, tidal_wall 3; styles: BRAWLER 0, TACTICIAN 17, COUNTERPUNCHER 1, SHOWBOAT 6

| gate | requirement | measured | result |
|---|---|---|---|
| G9 | every re-measured climbed spec <= 65% and each has a pool counter >= 55% | top-5 max 61.5%, known exploits max 60.0%, 5/5 have a counter | PASS |

## Diagnostics

win rate by school (mean over specs):
- BLAZE: 47.4% (354 specs)
- TIDE: 47.3% (330 specs)
- VOLT: 48.0% (334 specs)
- IRON: 47.2% (327 specs)
- MIND: 48.1% (369 specs)
- WILD: 46.9% (326 specs)

win rate by number of Strike moves:
- 1 strikes: 44.6% (730 specs)
- 2 strikes: 48.6% (891 specs)
- 3 strikes: 50.2% (419 specs)

win rate by style:
- BRAWLER: 46.6% (503 specs)
- TACTICIAN: 48.1% (503 specs)
- COUNTERPUNCHER: 47.4% (513 specs)
- SHOWBOAT: 47.9% (521 specs)

win rate by arena rule (mean spread over specs; fights per rule equal):
- rule 0 : decisive wins 47.7%
- rule 1 : decisive wins 47.7%
- rule 2 : decisive wins 47.5%
- rule 3 : decisive wins 47.6%
- rule 4 : decisive wins 47.7%
- rule 5 : decisive wins 47.2%
- rule 6 : decisive wins 47.6%
- rule 7 : decisive wins 47.8%

moves: win rate of specs containing the move, and appearances in the top 25%:
- ember_jab       BLAZE cost  7  mean WR 46.9%  top25 37
- flame_lash      BLAZE cost  8  mean WR 48.8%  top25 57
- fire_whirl      BLAZE cost  9  mean WR 49.7%  top25 67
- inferno         BLAZE cost 12  mean WR 48.7%  top25 39
- smolder         BLAZE cost  7  mean WR 45.6%  top25 24
- battle_roar     BLAZE cost  8  mean WR 44.3%  top25 18
- melt_through    BLAZE cost 10  mean WR 48.0%  top25 40
- wave_slap       TIDE  cost  7  mean WR 48.1%  top25 48
- undertow        TIDE  cost  8  mean WR 48.4%  top25 57
- riptide         TIDE  cost 10  mean WR 48.5%  top25 38
- tidal_wall      TIDE  cost  7  mean WR 48.1%  top25 43
- healing_rain    TIDE  cost  8  mean WR 46.0%  top25 21
- salt_spray      TIDE  cost  7  mean WR 46.0%  top25 17
- spark           VOLT  cost  6  mean WR 48.7%  top25 65
- arc_bolt        VOLT  cost  9  mean WR 48.6%  top25 59
- chain_shock     VOLT  cost 10  mean WR 49.4%  top25 67
- overclock       VOLT  cost 12  mean WR 43.3%  top25 8
- thunderclap     VOLT  cost 11  mean WR 48.2%  top25 59
- static_field    VOLT  cost  7  mean WR 48.1%  top25 50
- iron_fist       IRON  cost  8  mean WR 47.9%  top25 41
- bulwark         IRON  cost  7  mean WR 46.9%  top25 31
- riposte         IRON  cost  8  mean WR 46.4%  top25 20
- wrecking_swing  IRON  cost 12  mean WR 48.1%  top25 33
- armor_up        IRON  cost  7  mean WR 46.0%  top25 23
- rivet_barrage   IRON  cost 10  mean WR 48.5%  top25 39
- dent            IRON  cost  8  mean WR 48.8%  top25 50
- mind_spike      MIND  cost  8  mean WR 48.4%  top25 60
- hex_gaze        MIND  cost  6  mean WR 47.0%  top25 33
- foresight       MIND  cost  7  mean WR 46.3%  top25 25
- brain_freeze    MIND  cost  9  mean WR 48.3%  top25 61
- focus           MIND  cost 10  mean WR 44.2%  top25 17
- psy_siphon      MIND  cost 10  mean WR 48.8%  top25 51
- claw_swipe      WILD  cost  7  mean WR 46.8%  top25 30
- venom_bite      WILD  cost  8  mean WR 47.5%  top25 44
- pounce          WILD  cost  9  mean WR 48.9%  top25 59
- regrowth        WILD  cost  9  mean WR 45.8%  top25 17
- thorn_wall      WILD  cost 10  mean WR 48.0%  top25 47
- stampede        WILD  cost 11  mean WR 48.6%  top25 35

win-rate quantiles (specs): min 28.0% p10 41.3% p50 48.0% p90 53.5% max 59.4%
champion-seat win share over part B fights: 47.5%  (side bias check; draws 5.1% )
per-matchup mean exchanges/round: min 4.215 max 9.947

archetypes (win rate vs pool, decisive wins only):
- Last Slice               BLAZE COUNTERPUNCHER 57.3%  | the last slice of pizza at a party
- Lumen Lurch              VOLT  BRAWLER        55.0%  | a moth obsessed with streetlights
- Counselor Coo            MIND  TACTICIAN      54.7%  | a pigeon with a law degree
- Mic Drop Mona            VOLT  SHOWBOAT       54.6%  | a karaoke champion who cannot stop singing
- Fern Master Frond        WILD  TACTICIAN      52.6%  | a houseplant with a black belt
- Sir Squidley             TIDE  TACTICIAN      52.5%  | a very polite kraken
- Auditor Abaddon          BLAZE TACTICIAN      52.1%  | a tax inspector from the underworld
- Cart Blanche             VOLT  BRAWLER        52.0%  | a self-driving shopping cart gone rogue
- Sergeant Fetch           WILD  BRAWLER        51.8%  | a golden retriever who thinks it is a bodyguard
- Ronin Prickles           WILD  COUNTERPUNCHER 51.7%  | a hedgehog in samurai armor
- Bridezilla Whisperer     MIND  TACTICIAN      51.7%  | an overworked wedding planner
- Cumulus Grudge           VOLT  BRAWLER        51.6%  | a cloud with a grudge
- Trash Panda Tony         WILD  SHOWBOAT       51.0%  | a raccoon running a casino
- Whistle Wendy            TIDE  TACTICIAN      50.7%  | a lifeguard who hates water
- Sir Trembles-a-Lot       IRON  COUNTERPUNCHER 50.6%  | a medieval knight afraid of horses
- Toastzilla               BLAZE SHOWBOAT       50.5%  | a toaster that believes it is a dragon
- Lumi Bloom               TIDE  COUNTERPUNCHER 50.3%  | a jellyfish pretending to be a lamp
- Marcel Boxwell           IRON  COUNTERPUNCHER 50.2%  | a mime trapped in an invisible box
- Honk Vengeance           WILD  BRAWLER        49.7%  | the world's angriest goose
- Vendetta 3000            IRON  TACTICIAN      49.4%  | a vending machine that hates exact change
- Ducky Poseidon           TIDE  SHOWBOAT       49.4%  | a rubber duck with a trident
- One-Spell Wendell        BLAZE BRAWLER        49.1%  | a wizard who only knows one spell
- Madam Hush               MIND  COUNTERPUNCHER 48.9%  | a librarian who bans noise
- Pocket Kasparooni        MIND  TACTICIAN      48.9%  | a very small very angry chess grandmaster
- Decaf Dave               BLAZE SHOWBOAT       48.8%  | a barista who has not slept in three days
- Beacon Bruno             TIDE  COUNTERPUNCHER 48.7%  | a retired lighthouse keeper turned boxer
- Granny Purl              IRON  COUNTERPUNCHER 48.6%  | a grandma who never stops knitting
- Pawsitive Chaos          WILD  SHOWBOAT       48.3%  | a cat who has already knocked everything off the shelf
- Gale Grumble             TIDE  BRAWLER        48.0%  | the north wind in a bad mood
- Captain Chowder          TIDE  BRAWLER        47.9%  | a pirate captain made of soup
- Bonesy Overdue           IRON  SHOWBOAT       47.8%  | a skeleton who is late for work
- Cell Block Charlie       MIND  TACTICIAN      47.8%  | a sentient spreadsheet
- Turbo Escargot           VOLT  SHOWBOAT       47.6%  | a snail with a rocket backpack
- Mirror Ball Maurice      VOLT  SHOWBOAT       47.6%  | a disco ball with abandonment issues
- Beacon of Boo            MIND  COUNTERPUNCHER 47.3%  | a haunted lighthouse
- Straw Boss               WILD  COUNTERPUNCHER 47.3%  | a scarecrow who just wants a day off
- Old Grumblerock          IRON  BRAWLER        47.1%  | a grumpy mountain
- Ticket 404               MIND  TACTICIAN      46.5%  | a ghost who haunts the DMV
- Hoardy McFluff           BLAZE TACTICIAN      46.5%  | a dragon who only collects socks
- Intern Admin             VOLT  TACTICIAN      45.3%  | an intern with the CEO's password

top 10 specs:
- rand1217   MIND SHOWBOAT ["foresight", "psy_siphon", "bulwark"] stats [16, 17, 21, 22] WR 59.4%
- rand1179   MIND SHOWBOAT ["hex_gaze", "brain_freeze", "venom_bite"] stats [9, 24, 22, 22] WR 59.2%
- rand1497   BLAZE TACTICIAN ["fire_whirl", "inferno", "riposte"] stats [7, 16, 26, 22] WR 59.0%
- rand426    VOLT SHOWBOAT ["mind_spike", "dent", "chain_shock"] stats [13, 13, 26, 22] WR 58.7%
- rand521    MIND COUNTERPUNCHER ["mind_spike", "brain_freeze", "pounce"] stats [23, 7, 25, 19] WR 58.4%
- rand1679   VOLT SHOWBOAT ["chain_shock", "static_field", "thorn_wall"] stats [14, 17, 19, 23] WR 58.3%
- rand1605   IRON COUNTERPUNCHER ["bulwark", "dent", "chain_shock"] stats [18, 13, 22, 22] WR 58.1%
- rand683    MIND SHOWBOAT ["hex_gaze", "brain_freeze", "venom_bite"] stats [15, 13, 27, 22] WR 57.7%
- rand1701   VOLT SHOWBOAT ["spark", "chain_shock", "wrecking_swing"] stats [19, 7, 23, 23] WR 57.7%
- rand69     TIDE SHOWBOAT ["riptide", "undertow", "inferno"] stats [15, 20, 25, 10] WR 57.6%

bottom 5 specs:
- rand1758   VOLT SHOWBOAT ["brain_freeze", "focus", "overclock"] stats [9, 25, 23, 12] WR 28.0%
- rand1218   IRON COUNTERPUNCHER ["thunderclap", "foresight", "focus"] stats [31, 10, 10, 21] WR 30.0%
- rand1869   BLAZE BRAWLER ["battle_roar", "inferno", "smolder"] stats [24, 27, 11, 11] WR 30.9%
- rand1652   TIDE COUNTERPUNCHER ["wrecking_swing", "battle_roar", "focus"] stats [20, 22, 13, 15] WR 31.3%
- rand4      VOLT BRAWLER ["regrowth", "healing_rain", "riptide"] stats [31, 24, 8, 10] WR 31.5%
