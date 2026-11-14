# NEAR AI spend control (agent-to-agent contract; enforced in code)

Facts (live, 14 Nov): compile model `z-ai/glm-5.3-flash` with `"reasoning_effort":"low"` — ~2,705 prompt tokens,
~160–200 completion tokens, $0.08/M in, $0.50/M out → ~$0.0003 per compile; worst case (700 completion tokens)
$0.00064. Portraits `black-forest-labs/FLUX.2-klein-4B` $0.012 each, signed (provider_tee). Prices come from
`GET /v1/models` (`pricing.prompt`/`completion` per token, `pricing.image` per image).

## Budgets
- `NEARAI_BUDGET_USD` (config, per key): the lifetime hard stop for that key. Current key: 2.50 (build, tests, demo).
  Launch key (fresh account, ~$10 funded by Gabriel): ~9.00 via the rotate script.
- `NEARAI_PUBLIC_DAILY_USD` (config): what public (non-owner) traffic may spend per UTC day. Current key: 0.05.
  `NEARAI_PUBLIC_TOTAL_USD`: lifetime public share on this key. Current key: 0.25. Launch key: e.g. 1.00/day, 8.50 total.
- The ledger is keyed by `fp = sha256(key)[0..16]` hex (never the key). A new key → a fresh ledger automatically.

## Worker ledger (web/functions/_lib/ledger.ts, KV)
- Every paid call (preview compile, portrait, opener) is priced from the returned `usage` × cached `/v1/models`
  pricing (images: flat `pricing.image`); unknown usage → worst case. Records `{ts, kind, model, in, out, usd, who}`
  as daily aggregates `ledger:{fp}:day:{YYYY-MM-DD}` and a lifetime aggregate `ledger:{fp}:total` (write-coalesced, KV
  1 write/s/key safe), plus a bounded recent log.
- Reserve-then-settle: before a call, reserve the worst-case cost; refuse if `total + reserved + worst > budget`
  or the public daily/total cap would be exceeded (owner/test traffic authenticated by `x-tick-secret` bypasses only the
  public caps, never the hard stop). After the call, settle to the real cost.
- Contract forges are charged too: the tick reads the contract's compile counter and charges
  `newCompiles × worstCaseCompileUsd` to the ledger under kind `forge`.
- Caches: preview by sentence hash (already), portraits by sentence hash (already), openers per season.
- Exhausted → `/api/state` exposes `forge: {open: bool, reason, resetsAt}`; `/api/preview` returns
  `503 {code:'FORGE_CLOSED'}`; `/api/portrait` returns `404 {code:'PORTRAIT_BUDGET'}` (UI shows a labelled stock emblem).

## Contract cap (code-enforced; players call OutLayer through the contract, not through the worker)
- `set_compile_caps(daily: u32, total: u32)` (owner, 1 yocto) and counters `compiles_today` (UTC day index from
  block timestamp) and `compiles_total` (since the last `reset_compile_counter`, owner, used on key rotation).
- `challenge`/`open_season` with `need_compile` refuse with `E_FORGE_CLOSED` when either cap is reached (no toll is
  debited). Cached sentences (no compile) are never blocked. View `get_compile_caps` → `{daily, total, today, used, day}`.
- Current key: daily 60, total 250 (≤ $0.16 at worst case). Launch: set from the rotate script:
  `total = floor(public_total_usd / 0.00064)`, `daily = floor(public_daily_usd / 0.00064)`.

## Rotate script (scripts/rotate-nearai-key.sh)
`rotate-nearai-key.sh --budget 9 --public-daily 1 --public-total 8.5 [--dry-run]`:
1. `~/.claude/vault/inject.sh get TITLE_SHOT_NEARAI_API_KEY` into a temp dir, then replace `NEARAI_API_KEY` in
   `.env.local` (never echo it).
2. `wrangler pages secret put NEARAI_API_KEY` (stdin) + vars `NEARAI_BUDGET_USD`, public caps, for project `title-shot`.
3. Update the OutLayer project secret (forge README command; via the production contract).
4. Contract: `reset_compile_counter` + `set_compile_caps` from the public caps.
5. One smoke call: a 1-token completion (or `/v1/models` with auth) → expect 200; print only the key fingerprint.
