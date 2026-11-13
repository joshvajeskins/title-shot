# bout-sim balance sweep

pool = 40 archetypes + 2000 random valid specs (half uniform, half school-themed) = 2040
part A: each spec vs 300 opponents x 5 seeds x 8 rules = 12000 fights/spec
part B: 1000 random pairs x 25 seeds x 8 rules = 200 fights/pair; counters: top-50 vs whole pool at the same depth
mode: FULL  elapsed: A 12s, B 0s, counters 0s

definitions: win rate = decisive wins / fights (draws count as non-wins), seats alternate; G2 counter = a pool spec with >=55% decisive wins against the target at the part-B depth (first one found); G4 p = (wins + draws/2)/fights per pair, pairs drawn at random from the pool, noise floor shown as the pure-dice null; G6 stun loss = skipped turns / (skipped + acted turns) per fighter per matchup, max over matchups; G7 top 25% = best quarter of the pool by win rate.

## Gates

| gate | requirement | measured | result |
|---|---|---|---|
| G1 | no spec > 65% win rate vs pool | max 61.3% | PASS |
| G2 | every top-50 spec has a counter >= 55% | 50/50 found | PASS |
| G3 | every archetype within 30-70% | 43.4% .. 58.9% | PASS |
| G4 | mean |p-0.5| over random pairs >= 0.12 | 0.156 (pure-dice null 0.028) | PASS |
| G5 | match draw rate 3-12% | 5.2% | PASS |
| G6 | mean exchanges/round 5-10, max stun-turn loss <= 40% | 6.87 ex/round, max stun loss 22.0% | PASS |
| G7 | top-25% has >=80% of moves, all schools, all styles | 38/38 moves, 6/6 schools, 4/4 styles | PASS |
| G8 | events per fight <= 200 | max 149 | PASS |

**ALL GATES PASS**

## Diagnostics

win rate by school (mean over specs):
- BLAZE: 47.8% (354 specs)
- TIDE: 47.6% (330 specs)
- VOLT: 47.8% (334 specs)
- IRON: 46.5% (327 specs)
- MIND: 48.5% (369 specs)
- WILD: 46.2% (326 specs)

win rate by number of Strike moves:
- 1 strikes: 47.4% (730 specs)
- 2 strikes: 47.9% (891 specs)
- 3 strikes: 46.7% (419 specs)

win rate by style:
- BRAWLER: 46.3% (503 specs)
- TACTICIAN: 48.0% (503 specs)
- COUNTERPUNCHER: 46.9% (513 specs)
- SHOWBOAT: 48.7% (521 specs)

win rate by arena rule (mean spread over specs; fights per rule equal):
- rule 0 : decisive wins 47.6%
- rule 1 : decisive wins 47.6%
- rule 2 : decisive wins 47.4%
- rule 3 : decisive wins 47.6%
- rule 4 : decisive wins 47.7%
- rule 5 : decisive wins 47.2%
- rule 6 : decisive wins 47.6%
- rule 7 : decisive wins 47.8%

moves: win rate of specs containing the move, and appearances in the top 25%:
- ember_jab       BLAZE cost  6  mean WR 47.7%  top25 42
- flame_lash      BLAZE cost  8  mean WR 48.3%  top25 45
- fire_whirl      BLAZE cost  9  mean WR 48.2%  top25 43
- inferno         BLAZE cost 12  mean WR 48.3%  top25 36
- smolder         BLAZE cost  7  mean WR 48.4%  top25 43
- battle_roar     BLAZE cost  8  mean WR 48.6%  top25 64
- melt_through    BLAZE cost 10  mean WR 47.5%  top25 44
- wave_slap       TIDE  cost  6  mean WR 48.3%  top25 61
- undertow        TIDE  cost  8  mean WR 47.3%  top25 41
- riptide         TIDE  cost 10  mean WR 49.0%  top25 56
- tidal_wall      TIDE  cost  7  mean WR 47.6%  top25 42
- healing_rain    TIDE  cost  8  mean WR 48.3%  top25 49
- salt_spray      TIDE  cost  7  mean WR 46.1%  top25 31
- spark           VOLT  cost  6  mean WR 47.4%  top25 42
- arc_bolt        VOLT  cost  9  mean WR 47.5%  top25 43
- chain_shock     VOLT  cost 10  mean WR 48.0%  top25 42
- overclock       VOLT  cost 12  mean WR 49.4%  top25 56
- thunderclap     VOLT  cost 11  mean WR 46.4%  top25 31
- static_field    VOLT  cost  7  mean WR 46.6%  top25 35
- iron_fist       IRON  cost  8  mean WR 46.3%  top25 29
- bulwark         IRON  cost  7  mean WR 47.0%  top25 32
- riposte         IRON  cost  8  mean WR 46.3%  top25 28
- wrecking_swing  IRON  cost 12  mean WR 46.5%  top25 27
- armor_up        IRON  cost  7  mean WR 47.6%  top25 34
- rivet_barrage   IRON  cost 10  mean WR 47.6%  top25 35
- dent            IRON  cost  8  mean WR 46.7%  top25 21
- mind_spike      MIND  cost  8  mean WR 47.1%  top25 44
- hex_gaze        MIND  cost  6  mean WR 47.1%  top25 38
- foresight       MIND  cost  5  mean WR 47.2%  top25 42
- brain_freeze    MIND  cost  9  mean WR 48.2%  top25 58
- focus           MIND  cost 10  mean WR 48.8%  top25 70
- psy_siphon      MIND  cost 10  mean WR 47.4%  top25 34
- claw_swipe      WILD  cost  7  mean WR 45.3%  top25 24
- venom_bite      WILD  cost  8  mean WR 46.9%  top25 41
- pounce          WILD  cost  9  mean WR 47.8%  top25 42
- regrowth        WILD  cost  9  mean WR 47.2%  top25 29
- thorn_wall      WILD  cost  9  mean WR 47.8%  top25 37
- stampede        WILD  cost 11  mean WR 46.3%  top25 19

win-rate quantiles (specs): min 31.7% p10 41.2% p50 47.6% p90 53.7% max 61.3%
champion-seat win share over part B fights: 47.4%  (side bias check; draws 5.2% )
per-matchup mean exchanges/round: min 3.840 max 9.973

archetypes (win rate vs pool, decisive wins only):
- Last Slice               BLAZE COUNTERPUNCHER 58.9%  | the last slice of pizza at a party
- Ducky Poseidon           TIDE  SHOWBOAT       57.4%  | a rubber duck with a trident
- Bridezilla Whisperer     MIND  TACTICIAN      56.1%  | an overworked wedding planner
- Hoardy McFluff           BLAZE TACTICIAN      55.2%  | a dragon who only collects socks
- Decaf Dave               BLAZE SHOWBOAT       55.1%  | a barista who has not slept in three days
- Mirror Ball Maurice      VOLT  SHOWBOAT       55.1%  | a disco ball with abandonment issues
- Sir Squidley             TIDE  TACTICIAN      54.8%  | a very polite kraken
- Toastzilla               BLAZE SHOWBOAT       54.7%  | a toaster that believes it is a dragon
- Cumulus Grudge           VOLT  BRAWLER        54.4%  | a cloud with a grudge
- Turbo Escargot           VOLT  SHOWBOAT       52.9%  | a snail with a rocket backpack
- Lumen Lurch              VOLT  BRAWLER        52.9%  | a moth obsessed with streetlights
- Counselor Coo            MIND  TACTICIAN      51.9%  | a pigeon with a law degree
- Fern Master Frond        WILD  TACTICIAN      51.5%  | a houseplant with a black belt
- Mic Drop Mona            VOLT  SHOWBOAT       51.2%  | a karaoke champion who cannot stop singing
- Trash Panda Tony         WILD  SHOWBOAT       51.1%  | a raccoon running a casino
- Cart Blanche             VOLT  BRAWLER        50.1%  | a self-driving shopping cart gone rogue
- Cell Block Charlie       MIND  TACTICIAN      50.0%  | a sentient spreadsheet
- Ronin Prickles           WILD  COUNTERPUNCHER 49.5%  | a hedgehog in samurai armor
- Captain Chowder          TIDE  BRAWLER        49.3%  | a pirate captain made of soup
- Marcel Boxwell           IRON  COUNTERPUNCHER 49.0%  | a mime trapped in an invisible box
- Intern Admin             VOLT  TACTICIAN      49.0%  | an intern with the CEO's password
- Pocket Kasparooni        MIND  TACTICIAN      48.9%  | a very small very angry chess grandmaster
- Sir Trembles-a-Lot       IRON  COUNTERPUNCHER 48.2%  | a medieval knight afraid of horses
- Auditor Abaddon          BLAZE TACTICIAN      48.2%  | a tax inspector from the underworld
- Straw Boss               WILD  COUNTERPUNCHER 48.2%  | a scarecrow who just wants a day off
- Bonesy Overdue           IRON  SHOWBOAT       48.1%  | a skeleton who is late for work
- Honk Vengeance           WILD  BRAWLER        47.8%  | the world's angriest goose
- Sergeant Fetch           WILD  BRAWLER        47.8%  | a golden retriever who thinks it is a bodyguard
- Madam Hush               MIND  COUNTERPUNCHER 47.8%  | a librarian who bans noise
- One-Spell Wendell        BLAZE BRAWLER        47.7%  | a wizard who only knows one spell
- Beacon Bruno             TIDE  COUNTERPUNCHER 47.4%  | a retired lighthouse keeper turned boxer
- Granny Purl              IRON  COUNTERPUNCHER 46.9%  | a grandma who never stops knitting
- Ticket 404               MIND  TACTICIAN      46.9%  | a ghost who haunts the DMV
- Pawsitive Chaos          WILD  SHOWBOAT       46.7%  | a cat who has already knocked everything off the shelf
- Whistle Wendy            TIDE  TACTICIAN      46.5%  | a lifeguard who hates water
- Gale Grumble             TIDE  BRAWLER        46.1%  | the north wind in a bad mood
- Lumi Bloom               TIDE  COUNTERPUNCHER 45.3%  | a jellyfish pretending to be a lamp
- Old Grumblerock          IRON  BRAWLER        44.3%  | a grumpy mountain
- Vendetta 3000            IRON  TACTICIAN      44.1%  | a vending machine that hates exact change
- Beacon of Boo            MIND  COUNTERPUNCHER 43.4%  | a haunted lighthouse

top 10 specs:
- rand183    BLAZE SHOWBOAT ["melt_through", "battle_roar", "rivet_barrage"] stats [22, 12, 30, 8] WR 61.3%
- rand1653   VOLT SHOWBOAT ["chain_shock", "overclock", "thunderclap"] stats [9, 9, 36, 13] WR 61.3%
- rand1217   MIND SHOWBOAT ["foresight", "psy_siphon", "bulwark"] stats [16, 18, 21, 23] WR 61.0%
- rand1237   TIDE SHOWBOAT ["wave_slap", "riptide", "battle_roar"] stats [8, 16, 30, 22] WR 60.3%
- rand731    BLAZE TACTICIAN ["smolder", "battle_roar", "ember_jab"] stats [9, 13, 13, 44] WR 60.0%
- rand655    VOLT SHOWBOAT ["static_field", "overclock", "rivet_barrage"] stats [11, 16, 11, 33] WR 59.9%
- rand416    IRON SHOWBOAT ["rivet_barrage", "focus", "wrecking_swing"] stats [18, 8, 22, 20] WR 59.7%
- rand683    MIND SHOWBOAT ["hex_gaze", "brain_freeze", "venom_bite"] stats [15, 13, 27, 22] WR 59.7%
- rand956    MIND SHOWBOAT ["wrecking_swing", "focus", "mind_spike"] stats [13, 17, 16, 24] WR 59.6%
- rand982    IRON SHOWBOAT ["thunderclap", "riptide", "battle_roar"] stats [7, 13, 26, 25] WR 59.6%

bottom 5 specs:
- rand936    TIDE BRAWLER ["claw_swipe", "iron_fist", "bulwark"] stats [33, 27, 8, 10] WR 31.7%
- rand1218   IRON COUNTERPUNCHER ["thunderclap", "foresight", "focus"] stats [32, 11, 10, 21] WR 32.9%
- rand59     IRON SHOWBOAT ["dent", "iron_fist", "riposte"] stats [28, 28, 10, 10] WR 32.9%
- rand1075   MIND COUNTERPUNCHER ["foresight", "brain_freeze", "arc_bolt"] stats [16, 41, 12, 8] WR 33.2%
- rand114    WILD BRAWLER ["bulwark", "riposte", "wave_slap"] stats [28, 31, 12, 8] WR 33.2%
