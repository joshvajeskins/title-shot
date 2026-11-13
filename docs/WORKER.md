# Worker, relayer, promoter NPC and the browser chain client (agent-to-agent contract)

Host: Cloudflare Pages project `title-shot` (preview URL only; pre-approved). API = Pages Functions in `web/functions/api/*`
(TypeScript, no Node APIs; `@near-js/*` or `near-api-js` that runs on Workers; `viem` for Base Sepolia). Promoter cron:
a tiny separate Worker `title-shot-bell` (cron every 5 min) that only calls `POST {PAGES_URL}/api/tick` with a shared
secret; everything else is lazy (lobby loads also trigger a throttled tick). Secrets via `wrangler pages secret put`
(never in files): `NEARAI_API_KEY`, `ELEVENLABS_API_KEY`, `SPONSOR_KEY` (full-access key of `play.titleshot.testnet`),
`VANCE_KEY` (full-access key of `vance.titleshot.testnet`), `RELAYER_KEY` (full-access key of `relay.titleshot.testnet`),
`TICK_SECRET`. KV namespace `TS_KV` for rate limits and caches. All inputs validated (zod); errors return
`{error, code}` with a proper status; never a raw upstream error.

## Endpoints
| Route | What | Limits |
|---|---|---|
| `POST /api/guest` `{publicKey, sessionKey}` (ed25519, base58 `ed25519:`) | Creates `<adjective>-<noun>-<nn>.play.titleshot.testnet` with full-access `publicKey`, adds `sessionKey` as a function-call key (receiver = contract, methods `["challenge"]`, allowance 0.5 NEAR), funds 0.15 NEAR for gas, then `deposit_for(account)` 0.5 NEAR. Returns `{accountId}`. | 3/IP/day, 150/day global, sponsor balance floor 3 NEAR (`503 {code:"SPONSOR_DRY"}`) |
| `POST /api/preview` `{sentence}` | If `get_fighter_by_sentence` exists → `{spec, canonical:true, portrait}`. Else POST the exact bytes `prefix ‖ escape(sentence) ‖ suffix` (from the bout-sim wasm `request_parts(model)`) to NEAR AI, fetch the signature, normalize with the same wasm, return `{spec, canonical:false, raw, signature:{text, signing_address, signature, kind}, requestSha256, responseSha256}`; cache by sentence hash 1 h. Refused → `422 {code:"REFUSED"}`. | 12/IP/min, 300/IP/day |
| `GET /api/portrait/:hash` | Fighter portrait (webp/png). Cache hit → bytes. Miss: look up the fighter (chain, or the preview cache) and generate with NEAR AI Cloud images (`/v1/images/generations`, model per `GET /v1/models`, FLUX if listed) using the house style prompt + the fighter's `look`, seed = first 4 bytes of the hash. Store in KV. If image generation is unavailable, `404 {code:"NO_PORTRAIT"}` (the UI falls back to the school emblem). | gen 6/IP/min |
| `GET /api/cry/:hash` | mp3 of the fighter's battle cry (`cry` field) via ElevenLabs TTS, voice chosen deterministically from `web/public/audio/fighter_voices.json` by school/style/hash; text filtered (≤ 60 chars, letters/punctuation only). Cached in KV. | gen 6/IP/min |
| `GET /api/state` | One JSON with belts (+ season, holder, champion fighter, defences), last 30 fights, promoter wallets and balances. Cached 3 s (KV + in-memory) so browsers don't hammer RPC. | — |
| `POST /api/tick` (header `x-tick-secret` or throttled lazy call) | Promoter NPC + bell: for each belt whose season ended and has no pending → `close_season`; payouts without raw tx → `sign_payout` (fees from `eth_feeHistory`, gas from `eth_estimateGas` +20%, clamped to the contract bounds); signed but not mined → broadcast + record the hash in KV; belts with no open season → Vance writes an opener sentence with NEAR AI (short creative prompt; must pass `sentenceProblem`), funds the next purse from Vance's own Chain-Signatures Base address (Vance calls `v1.signer-prod.testnet.sign` itself with path `vance-purse`; tx built with viem; amount from env `PURSE_WEI`, default 0.002 ETH) and calls `open_season`. Idempotent; logs to KV `tick:last`. | 1 run per 20 s |

## Relayer fallback (only if `forge_mode = relayer`)
`/api/tick` also scans `forge_requested` challenges (via `get_challenge` of the pending list) and calls `submit_forge` with the
NEAR AI response bytes and signature (same request bytes as above). Uses `RELAYER_KEY`.

## Browser chain client `web/src/game/near.ts` (implements `GameClient` in `web/src/game/client.ts`)
- RPC: `https://near-testnet.drpc.org` with fallbacks (see docs/ARCHITECTURE.md); views go through `/api/state` first.
- Guest account: generate two ed25519 keypairs in the browser (full + session), `POST /api/guest`, store both in
  `localStorage` (`ts-account`), offer "export key" in the identity menu. `account()` reads balance via `balance_of`.
- `challenge`: sign `challenge(belt_id, sentence)` with the **session** key (300 Tgas), get the challenge id from the
  receipt/logs, then poll `get_challenge(id)` every 1.5 s and map statuses to `ForgeProgress` (`toll` on tx success,
  `tee` once OutLayer has the request, `compile`/`verify` from the `forged`/`rejected` events, `fight` on `Resolved`).
  Errors map contract codes to readable sentences (`E_BALANCE` → "Top up: you need …", `E_PENDING`, `E_SELF`, …).
- `fight(id)`: read `get_fight(id)` + both fighters, re-run `simulate` in the bout-sim wasm (`web/src/sim/`), compare the
  wasm `state_hash` with the stored one (exposed to the UI as `verified`), and return a `Fight` with the replayed events.
- `odds`: bout-sim wasm `odds(champ, chall, rule, n)` (rule 255 = unknown/sealed → average over all 8 rules).
- `preview`: `POST /api/preview`.
- Portraits: `/api/portrait/:hash`, falling back to the curated roster art for the seeded sentences.
- Keep `MockClient` working; `?mock=1` or `VITE_MODE=mock` forces it (offline demo).

## Tests
Vitest for: input validation (each endpoint, hostile inputs), rate-limit logic, voice selection determinism, fee/gas
clamping, request-bytes equality with the Rust `request_parts` (golden file), error mapping, `near.ts` status mapping
(fixtures of `get_challenge` responses). A `scripts/smoke.mjs` that hits a deployed URL end to end.
