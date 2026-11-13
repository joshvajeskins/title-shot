# bout-sim event schema (rulebook titleshot-rulebook-v2)

`simulate(champion, challenger, seed, rule)` returns a `Fight`:

```
{ rounds: [RoundSummary], events: [Event], winner: "champion"|"challenger"|"draw",
  rounds_won: [champ, chall], state_hash: sha256(concat(encode(event))) }
```

Sides are numbers everywhere: `0` = champion (belt holder), `1` = challenger (payer). Round and match
`winner` fields use `0` champion, `1` challenger, `2` draw. HP and shield arrays are `[champion, challenger]`.
JSON (wasm) uses the tag field `"t"`. The wasm `simulate` returns `state_hash` as 64 hex characters.

Structural guarantees (checked by tests): first event `match_start`, last `match_end`; at most 3 rounds, 10
exchanges per round; at most 5 events per exchange so a fight is at most 158 events (sweep gate G8: <= 200).
HP is restored and every status cleared at each `round_start`; cooldowns reset too.

## Events

| `t` | fields | meaning |
|---|---|---|
| `match_start` | `rule` u8, `max_hp` [u16;2] | first event. Max HP = `140 + 2*grit` (grit 5..45 gives 150..230). |
| `round_start` | `round` 1..3, `form` [u8;2] | form = each side's damage multiplier in percent for the round (30..170, uniform), rolled per round and shown as an "in form / off day" banner. HP full again. |
| `exchange` | `round`, `n` 1..10, `first` | who acts first this exchange (speed + haste + dice). |
| `act` | see below | one fighter's action. Skipped when the fight ended mid-exchange. |
| `skip` | `actor` | the actor lost its action to a stun. It is stun-immune for the next 3 exchanges. |
| `upkeep` | `side`, `burn` u16, `hp` [u16;2], `expired` u8 | end-of-exchange for one side (only emitted when burn dealt damage or a status expired). |
| `round_end` | `round`, `winner`, `reason` `"ko"`/`"limit"`, `hp` | KO, or HP-percent at the exchange limit. HP fractions within 10 percentage points of each other = round draw (`DRAW_MARGIN_PM = 100` permille); a double KO is also a round draw. |
| `match_end` | `winner`, `rounds` [u8;2] | best of 3: first to 2 round wins; equal round wins after the rounds played = draw (champion keeps the belt). |

### `act` fields

| field | meaning |
|---|---|
| `actor` | 0/1 |
| `slot` | actor's move slot 0..2 (the spec's `moves[slot]`, use its `label` for the caption) or `3` = fallback basic move "Scrap" |
| `move_id` | library index (`rulebook_json().library[i].index`), `255` for the basic move |
| `outcome` | `hit`, `crit`, `miss`, `blocked` (a shield soaked everything), `countered` (the foe's counter stance reflected part of it), `used` (non-damaging move / hex that landed) |
| `hits` | landed hits for multihit moves, 0 for a miss or a move without damage |
| `dmg` | HP removed from the target (after the counter stance and shield) |
| `absorbed` | damage soaked by the target's shield |
| `heal` | HP the actor regained (lifesteal or a heal move) |
| `recoil` | HP the actor lost to a counter |
| `hp`, `shield` | `[champion, challenger]` after the action |
| `fx_self` | status flags put on the actor this action |
| `fx_foe` | status flags put on the foe this action |

Status flags (bit mask, used by `fx_self`, `fx_foe`, `upkeep.expired`):
`1` burn, `2` stun, `4` shield, `8` weaken, `16` haste, `32` counter, `64` charge.
`stun` appears only in `fx_foe` (the foe will lose its next action; a `skip` event follows).
`cleanse` has no flag; it only removes the actor's own burn and weaken. A `charge` flag in `fx_self` means the
next damaging move deals x3/2 and cannot miss. Heal moves report their effect in `heal`.

## Canonical encoding (what `state_hash` covers)

Each event is a tag byte followed by fixed-width little-endian fields in the order listed in `src/events.rs`
(`encode`). u16 values are 2 bytes LE. Tags: 1 match_start, 2 round_start, 3 exchange, 4 act, 5 skip, 6 upkeep,
7 round_end (reason 0 ko / 1 limit), 8 match_end. Outcome codes: 0 hit, 1 crit, 2 miss, 3 blocked, 4 countered, 5 used.
`state_hash = sha256(concatenation of all event encodings in order)`. Changing any number in `src/tune.rs` or
`src/moves.rs`, or any rule of the simulator, changes hashes: bump `RULEBOOK_VERSION` and regenerate
`fixtures/golden.json`.

## Rendering hints

- Order of captions in an exchange: `exchange` -> `act`/`skip` (first side) -> `act`/`skip` (second side, unless the
  round ended) -> `upkeep` per burning/expiring side.
- HP bars animate from the previous event's `hp` to this event's `hp`; shield bars use `shield`.
- `act.outcome == "crit"` = camera shake and a bigger number; `countered` = show the recoil on the actor.
- A fight with `winner == "draw"` is announced as a draw and the champion keeps the belt.
