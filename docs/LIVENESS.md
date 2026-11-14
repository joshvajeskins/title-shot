# House challengers: the arena runs by itself (agent-to-agent, terse)

Code: `web/functions/_lib/house.ts` (tick step), `web/functions/_lib/houseNpcs.ts` (personas, NEAR AI writer, curated lists).
Hook: one line in `tick.ts`, after `forge_charge` and **before** the relayer sweep, so in relayer mode a house challenge is
forged and fought in the same tick. Tests: `web/test/house.test.ts`. Setup: `scripts/setup-house.sh` (dry run; `--go`).

## Who
| Account | Persona | Bio |
|---|---|---|
| `house-a.titleshot.testnet` | Mother Ruckus | Runs the boiler-room gym under the arena and enters whoever is warming up on her bench. |
| `house-b.titleshot.testnet` | Professor Quill | A retired chess hustler who scouts fighters at bus stops and always bets on the strange ones. |
UI import: `HOUSE_PERSONAS` from `web/functions/_lib/houseNpcs.ts` (`{key, id, name, bio}`; no keys). Each account: full-access
key in `~/.near-credentials/testnet/` (legacy keychain), a function-call key (receiver `ring.titleshot.testnet`, methods
`["challenge"]`, allowance 0.25 NEAR) for the Worker, and a contract game balance it pays tolls from (`deposit`).

## Rule (per tick, at most one house challenge)
A belt is due when: season `Open`, champion set, `season.pending == 0`, more than 5 min before `closes_at`, and
`now − max(season opens_at, last bout on the belt, last house challenge on the belt) ≥ HOUSE_EVERY_MIN` (default 25).
Stalest due belt first. NPC = the richest one that is not the holder, has no pending challenge of its own and holds at least
toll + forge fee (else step `house:<a|b>` logs `HOUSE_DRY`). Sentence: NEAR AI (ledger reserve kind `opener`, who `tick`: skips
the public caps, never the hard stop; must pass `openerOk`/`sentenceProblem`, not the champion, not a recent house sentence);
NEAR AI error → the NPC's curated list. No compile may be spent (ledger closed, contract caps past half of `daily` or past 3/4
of `total`, or `HOUSE_COMPILES_PER_DAY` new fighters already today, default 12) → only a fighter the house already forged
(cached: no compile, no NEAR AI, never blocked by the caps); none → `HOUSE_FORGE_CLOSED`. The belt's KV marker
(`house:last:<belt>`) is written **before** `challenge` (a crash or refusal never retries before the cadence); the contract's
one-pending-per-account rule is the second guard. Gas: 50 Tgas in relayer mode (measured burn 4.4 Tgas), 300 in outlayer mode.
Testnet prepays gas at 10x the gas price: a 300 Tgas tx needs 0.301 NEAR of balance and of key allowance, else it is silently
dropped (NotEnoughBalance / allowance). Unused prepaid gas returns to the key allowance (measured: 0.25 → 0.2495 after one call).
Live check 14 Nov 15:15 IST: house-a challenged belt 2 (challenge #12, tx GTQGLtWppmTzmMjjtec3yrvNHWgraBJKY6cWKxit73b7) with the
real function-call key; the deployed worker's relayer forged it and bout #2 resolved (Vance's champion won).
Log step: `house_challenge:<a|b>` with `Name: "sentence" (nearai|fallback|cached)` and the tx hash, or the contract `E_` code.

## Env (Pages)
Secrets: `HOUSE_A_KEY`, `HOUSE_B_KEY` (function-call private keys; only in gitignored `.env.local`). Vars (optional):
`HOUSE_EVERY_MIN` (25), `HOUSE_COMPILES_PER_DAY` (12), `HOUSE_A_ID` / `HOUSE_B_ID` (staging accounts). No key → no house.

## Money (testnet NEAR, measured 14 Nov: toll 0.05, forge fee 0.01, 3 belts)
Each house challenge costs its toll (0.05 NEAR) from the NPC's game balance; when one NPC holds a belt and the other
challenges it, the holder earns the champion share (60 % of toll − fee − storage, ≈ 0.02). At the default cadence with three
idle belts the house makes up to ~7 challenges/hour, so 2 × 0.495 NEAR lasts roughly 3–4 hours. For multi-day judging set
`HOUSE_EVERY_MIN` to 60–120 and top up with `deposit` from the house accounts (full-access keys in the keychain).
NEAR AI: one opener-sized chat (~$0.00004) per new fighter plus its relayer compile. Note: `forgeChargeStep` charges every
contract compile, house ones included, to the **public** share at the worst case ($0.00064): 12/day ≈ $0.008 of the current
$0.05 public daily cap.
