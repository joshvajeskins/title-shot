# TITLE SHOT+ — architecture contract (agent-to-agent, terse)

Owner/integrator: Opus coordinator session. Source brief: `~/Documents/hackathons/_buildroom/hackathons/near-hackathon-2026-11/research/games-2026-11-14/BUILD-BRIEF-title-shot.md` (+ `panel/fusion-a.md` §CONCEPT 1, `panel/critic-build.md`).
Network: NEAR **testnet** only, Base Sepolia, (Solana devnet stretch). No mainnet, no real money.

## Game (one paragraph)
A player writes one sentence (3–120 chars). An attested AI (NEAR AI Cloud, model in a TEE) compiles it under a
public rulebook into a fighter spec (name, title, look, cry, school, stats, 3 moves, style). The player pays a toll
(from an in-contract balance, via a function-call key: no popup) to challenge the reigning champion of a belt.
OutLayer runs `forge.wasm` exactly once per paid challenge (secret API key, VRF seed) and calls back the contract.
The contract verifies the AI signature with `ecrecover`, normalizes/validates the spec with the shared
`bout-sim` crate, and runs a best-of-3 fight in-contract. Lose → toll split pays the champion's writer. Win →
belt (NEP-171) transfers. Season bell → purse paid on Base Sepolia by Chain Signatures (no key holder).

## Layout and ownership (never edit another lane's paths)
| Path | Owner |
|---|---|
| `crates/bout-sim/` (shared rules + sim, Rust, wasm-bindgen feature) | sim lane |
| `contract/` (near-sdk 5.x, the `titleshot` contract) | contract lane (starts after spikes) |
| `forge/` (OutLayer WASI-P2 app) | forge lane |
| `spikes/chainsig/`, `spikes/ecrecover/`, `spikes/forge-callback/` | the matching spike lane |
| `worker/` (Cloudflare Pages Functions / Worker: preview compile, relayer, promoter NPC, TTS cache) | later |
| `web/` except `web/public/audio/` | Opus (UI) |
| `web/public/audio/`, `assets/audio/` | audio lane |
| `assets/art/` | Opus (prompts) |
| `docs/ARCHITECTURE.md`, `README.md`, root `Cargo.toml` | Opus coordinator |
Each spike is a **standalone crate** (own `Cargo.toml`, no root workspace yet). Do **not** create a root `Cargo.toml`.
Do **not** `git commit` or push; the coordinator commits by path under the persona identity.

## Accounts and keys
- Root: `titleshot.testnet` (full-access key in `~/.near-credentials/testnet/titleshot.testnet.json`). Create
  sub-accounts `<lane>.titleshot.testnet` from it with `~/.cargo/bin/near` (near-cli-rs 0.30; the `near` on PATH is
  the old JS CLI). Store any new keys under `~/.near-credentials/testnet/` (legacy keychain), never in the repo.
- RPC: `https://near-testnet.drpc.org` (primary), `https://rpc.testnet.fastnear.com` (≈2 req/s then 429),
  `https://test.rpc.fastnear.com`, `https://testnet-rpc.intea.rs` (1 s slowdown). `rpc.testnet.near.org` is deprecated.
  near-cli-rs: pass a custom network or set the RPC in its config if the default 429s.
- Testnet NEAR is scarce: the faucet returns 429. Funding is the coordinator's job; spend sparingly, create
  sub-accounts with the minimum needed, delete/reclaim spike accounts when done.
- Repo `.env.local` (gitignored) holds: `ELEVENLABS_API_KEY`, `BASE_SEPOLIA_RPC_URL`, `ALCHEMY_API_KEY`,
  `PRIVATE_KEY` (a testnet-only EVM wallet), Cloudflare creds, and later `NEARAI_API_KEY`. Never print secrets.
- Reference builds (read-only, patterns only): `~/Documents/hackathons/near-standin/outlayer/` + `contracts/blocklist`
  (working contract → OutLayer → callback on testnet), `~/Documents/hackathons/near-lowball/server/src/llm/verify.ts`
  (NEAR AI signature verification in TS).

## Fighter spec (rulebook v1) — owned by `crates/bout-sim`
Raw AI output (what the model returns, JSON, strict schema):
```
{ "name": str<=24, "title": str<=40, "look": str<=160, "cry": str<=60,
  "school": enum[6], "style": enum[4], "moves": [moveId, moveId, moveId],
  "weights": {"power":1..10, "guard":1..10, "speed":1..10, "grit":1..10} }
```
`normalize(raw) -> Spec | Reject` is pure, integer-only, deterministic and shared by contract, forge, browser:
- moves distinct and in the library; strings trimmed, length-capped (reject if empty), no control chars.
- budget 100 = sum(move.cost for 3 moves) + sum(stats); stats get `100 - move_costs` points distributed by
  `weights` with the largest-remainder method, each stat clamped to [5, 45] (redistribute overflow deterministically).
- Reject reasons are stable codes (`E_UNKNOWN_MOVE`, `E_DUP_MOVE`, `E_BAD_SCHOOL`, `E_EMPTY_FIELD`, …).
Library: ~36–40 moves across 6 schools; each move `{id, name, school, kind, power, accuracy, cooldown, cost, effects}`.
Effects: burn, stun (chance), shield, pierce, lifesteal, multihit, charge, weaken, haste, counter, cleanse, heal.
School matchups: each school has 2 advantages (×5/4), 2 disadvantages (×4/5), 1 neutral.
Styles (deterministic move-choice policy): BRAWLER, TACTICIAN, COUNTERPUNCHER, SHOWBOAT.
Arena rule (season modifier, 8 values, `rule_id: u8`): e.g. BLAZE ×3/2, stuns halved, heals off, crits ×2, …
Fight: best-of-3 rounds, ≤10 exchanges each, initiative by speed + rng, KO or HP% at the limit; tied match → DRAW
(champion keeps the belt). RNG: splitmix64/PCG from a 32-byte seed. **No floats anywhere** (deny
`clippy::float_arithmetic`), no HashMap iteration. Output: event log + `winner` + `state_hash` (sha256 of the
canonical event encoding). Same crate → same hash in contract and browser.

## Forge request binding (contract can rebuild the request hash)
The NEAR AI request body is `PREFIX ‖ json_escape(sentence) ‖ SUFFIX`, where PREFIX/SUFFIX are fixed bytes produced
by `bout_sim::rulebook::request_parts(model_id)` (model, system prompt = rulebook, strict json_schema
response_format, `temperature: 0`, `stream: false`). `json_escape` = `serde_json::to_string(&sentence)` without the
outer quotes. The challenge id is **not** in the AI request: a sentence's compile is a pure function of the
sentence, so the free preview and the paid forge send identical bytes, and the **first paid forge of a sentence
is canonical forever** (contract caches spec by `sha256(sentence)`; later challenges with the same sentence reuse
it and only need a fresh VRF seed). OutLayer binds the result to the challenge via the promise callback.
Signature check in contract: `text = "{model_id}:{hex(sha256(req))}:{hex(sha256(resp))}"` (provider_tee) or
`"{hex(sha256(req))}:{hex(sha256(resp))}"` (gateway); digest = keccak256("\x19Ethereum Signed Message:\n" ‖ len ‖ text);
`env::ecrecover` → keccak(pubkey)[12..] must be in the admin-set, timelocked signer allowlist.
Fallback if OutLayer→NEAR AI fails: a relayer posts `(response bytes, signature)` directly; same checks; VRF
replaced by `env::random_seed` (flagged weaker, README must say "nobody can forge" not "nobody can re-roll").

## Economy (defaults; configurable per belt)
Toll 0.1 NEAR on testnet (scarce faucet). First `forge_fee` (measured; ~0.01) covers OutLayer; the rest splits
60% champion / 25% promoter / 10% season side-pot / 5% protocol (protocol funds the promoter NPC). Conservation
to the yocto is a property test. Purse at the bell: 50% final holder, 50% pro-rata to successful defences,
per-account cap; remainder to the final holder. Draw keeps champion. Self-challenge rejected.

## Times
Feature freeze 20:00 IST Sat 14 Nov. Video + README + package by 03:00 IST Sun 15 Nov. Deadline 05:29 IST.
