# `titleshot` contract — interface and rules (agent-to-agent contract)

Crate: `contract/` (near-sdk **=5.17.2**, Rust **1.86.0** via `rust-toolchain.toml`, `cargo near build non-reproducible-wasm --no-abi`,
`unstable` feature for `env::ecrecover`; see `spikes/chainsig/RESULT.md` "Risks" and `spikes/ecrecover/RESULT.md`).
Depends on `crates/bout-sim` by path (default features, no wasm-bindgen). Reuse code from `spikes/ecrecover/contract` (signature
check) and `spikes/chainsig/contract` (EIP-1559 build, signer call, raw-tx assembly, r/s leading-zero trim, ecrecover of the MPC
signature against the derived address). Money is yoctoNEAR `U128`. Times are ns (`env::block_timestamp`). Every refusal panics
with a stable code string `E_...` (listed below) unless stated "soft" (callback paths never panic: they refund and log).

## Roles
- `owner` (admin, `titleshot.testnet`): config, belts, relayers, AI signer allowlist (timelocked).
- `promoter` (per belt, e.g. the NPC `vance.titleshot.testnet`): opens seasons with an opener sentence and declares the purse.
- players: deposit, challenge (via a function-call key), withdraw.
- anyone: `close_season`, `sign_payout`, `expire_challenge`, views.

## Config (`new` + owner setters)
```
new(owner, outlayer: AccountId /*outlayer.testnet*/, forge_project: String, mpc_signer: AccountId /*v1.signer-prod.testnet*/,
    model_id: String, req_prefix: Base64VecU8, req_suffix: Base64VecU8, signature_kind: "provider_tee"|"gateway",
    signer_allowlist: Vec<String /*0x eth address*/>, forge_mode: "outlayer"|"relayer", allowlist_delay_sec: u64)
```
- `propose_allowlist(addrs)` (owner, 1 yocto) → pending until `now + allowlist_delay_sec`; `apply_allowlist()` anyone after the delay.
  `E_TIMELOCK` if early. Publish both in views: the trust point is visible and slow to change.
- `set_forge_mode(mode)`, `add_relayer(acct)`, `remove_relayer(acct)` (owner, 1 yocto).
- `create_belt(name, promoter, toll: U128, forge_fee: U128, purse_chain_id: u64)` (owner, 1 yocto) → `belt_id: u32`.
  `E_FEE`: forge_fee must be < toll and ≥ `MIN_FORGE_FEE` (covers OutLayer deposit + storage, 0.01 NEAR default).

## Balances
- `deposit()` payable → credits caller. First deposit of an account must cover `ACCOUNT_STORAGE` (0.005 NEAR, kept by the
  contract, not credited) → `E_STORAGE` if the deposit is smaller.
- `deposit_for(account)` payable (sponsor funds a guest account; same storage rule).
- `withdraw(amount: Option<U128>)` **1 yocto** (`assert_one_yocto`, so a function-call key can never call it), `E_BALANCE`.
- `balance_of(account) -> U128` view.

## Challenge lifecycle (the core)
`challenge(belt_id, sentence) -> u64` — **non-payable** (function-call keys cannot attach deposits). Checks in this order:
`E_NO_BELT`, `E_NO_SEASON` (no open season or `now >= closes_at`), `E_NO_CHAMPION` (opener not forged yet),
`E_SENTENCE` (after trim + whitespace collapse: 3..=120 chars, no control chars), `E_SELF` (caller is the belt holder),
`E_SAME_SENTENCE` (sentence hash equals the champion's), `E_PENDING` (caller already has a pending challenge anywhere),
`E_BALANCE` (balance < toll). Then: debit toll, create `Challenge{id, belt_id, season_id, challenger, sentence, hash,
status: Forging, created_at, need_compile}`; `need_compile = !fighters.contains(hash)`.
- forge_mode `outlayer`: `outlayer.request_execution(...)` with the forge_fee as deposit (shape from `spikes/forge-callback`,
  or Stand-in's `contracts/blocklist`), input `{op:"forge", sentence, need_compile, challenge_id, model_id}`, then
  `.then(on_forged(challenge_id))` with enough gas for the fight (measure; budget ≤ 300 Tgas total for the tx).
- forge_mode `relayer`: log event `forge_requested{challenge_id, sentence, need_compile}`; a listed relayer later calls
  `submit_forge(challenge_id, output_json)` (same parsing as the callback, VRF replaced by
  `sha256(env::random_seed() ‖ challenge_id)`, flagged `seed_source:"block"` in the event). `E_NOT_RELAYER`, `E_NOT_FORGING`.
- `on_forged(challenge_id)` (#[private] callback, **soft**): on promise failure / null / unparsable → `refund(minus forge_fee)`,
  status `Refunded{code}`. Else parse `{ok, response, signature, signing_algo, signature_kind, vrf:{output_hex,...}}`:
  1. if `need_compile`: verify the AI signature exactly as in `spikes/ecrecover` (rebuild `req = prefix ‖ escape(sentence) ‖ suffix`,
     text per kind, EIP-191, ecrecover, allowlist) → `E_AI_SIG`; parse envelope → content → `bout_sim` raw → `normalize` →
     any `Reject` (incl. `E_REFUSED`) → refund minus fee, status `Rejected{code}`. Store the canonical fighter
     `{sentence, spec, writer: challenger, forged_at, signer, record}` keyed by hash (**first paid forge of a sentence is final**).
  2. if `!need_compile` and the output carries a compile anyway → ignore it (the stored fighter wins).
  3. resolution guards (soft refunds): challenger is now the belt holder → `E_SELF`; season was closed → `E_CLOSED`.
  4. seed = `sha256("titleshot:seed:" ‖ vrf_output ‖ challenge_id_le)`. If the season's rule is unset (sealed), set
     `rule = seed[0] % 8` now and log `rule_revealed`.
  5. `bout_sim::simulate(champion_spec, challenger_spec, seed, rule)` → winner, state_hash.
  6. Split the toll `T` with fee `F`: `R = T − F`; champion holder `R*60/100`, promoter `R*25/100`, season side-pot
     `R*10/100`, protocol `R − the three` (exact integer remainder, so the sum is exactly `T`). Credit balances (holder,
     promoter), add to side-pot, add to protocol. The champion share goes to **whoever held the belt when the bout resolved,
     win or lose** (they are paid for being the target).
  7. winner challenger → internal NFT transfer of token `belt-{id}` to the challenger, `champion = hash`, `reign_since = now`,
     `defences = 0`. Champion or draw → `defences += 1` and `season.defence_count[holder] += 1` (a draw is a defence).
  8. Store `Fight{id, belt_id, season_id, champion_hash, challenger_hash, holder, challenger, seed, rule, winner, state_hash,
     split}`; status `Resolved{fight_id}`; update both fighters' w/l/d; log NEP-297 `bout`.
- `expire_challenge(id)` (anyone) after `FORGE_TIMEOUT` (10 min) while still `Forging` → refund minus fee. Soft no-op if
  already resolved. A late callback after expiry is a no-op (status check).
- Double callback / callback for an unknown id → no-op (status check). Callback from anyone but self → rejected by #[private].
- One pending challenge per account is cleared on every terminal status.

## Seasons and the bell
- `open_season(belt_id, opener_sentence, duration_sec, purse_wei: U128)` (belt promoter only, **payable**: attaches the
  forge fee) → `E_NOT_PROMOTER`, `E_SEASON_OPEN`, `E_DURATION` (60 s ..= 30 days). Forges the opener through the same path
  (challenge kind `Opener`; on success the opener becomes champion with **no fight**, belt NFT minted/transferred to the
  promoter; refund path as above). Season gets `id+1`, `opens_at`, `closes_at`, `rule: None` (sealed), purse
  `{chain_id, path: "belt-{id}-s{season}", amount_wei: purse_wei}`, side_pot 0. The purse's EVM address is derived off-chain
  (signer `derived_public_key` with predecessor = this contract) and recorded by `set_purse_address(belt, season, addr)`
  (promoter or owner, 1 yocto); `sign_payout` verifies every MPC signature recovers to that address (refuse otherwise).
- `close_season(belt_id)` (anyone) → `E_TOO_EARLY` before `closes_at`, `E_PENDING_BOUTS` while a challenge of this season is
  still `Forging` (they expire after 10 min), `E_CLOSED` if already closed (idempotent: no second payout plan).
  Purse plan (the anti-snipe split, a property test):
  - 0 challenges this season → 100% back to the promoter.
  - else 50% to the final holder; 50% pro-rata to `defence_count` holders, **each account capped at 25% of the purse**;
    any remainder (caps, rounding, no defences) to the final holder. Sum == purse_wei exactly.
  - side-pot NEAR → final holder's balance. Belt NFT stays with the holder; champion stays as next season's default
    opener unless the promoter forges a new one.
  - Creates `Payout{id, belt, season, payee: AccountId, amount_wei, to: Option<[u8;20]>, nonce: Option<u64>, raw_tx: None}`
    per payee. `to` is the payee's registered EVM address (`set_evm_address(addr)` 1 yocto) or None (claimable later via
    `claim_payout(payout_id, addr)` by the payee, 1 yocto).
- `sign_payout(payout_id, max_fee_per_gas: U128, max_priority_fee_per_gas: U128, gas_limit: u64)` (anyone): `E_NO_ADDRESS`,
  `E_GAS` (21000 ≤ gas ≤ 150000; fees ≤ 50 gwei), assigns the next sequential nonce of the purse address on first sign,
  `value = amount_wei − gas_limit*max_fee_per_gas` (the payee pays the gas; `E_DUST` if ≤ 0), builds EIP-1559 for
  `chain_id`, calls the signer (1 yocto, path = purse path, domain 0), callback stores the raw tx, verifies the recovered
  address, logs `payout_signed{raw_tx}`. Already signed → returns the stored raw tx (no new signature). A stuck tx may be
  re-signed with the same nonce only with a strictly higher `max_fee_per_gas` (`E_FEE_NOT_HIGHER`). Pending callback lost →
  `reset_payout_signing(id)` after 10 min.
- Anyone broadcasts `raw_tx` (the relayer/worker does it automatically).

## Belt token (NEP-171)
Standard `near-contract-standards` NonFungibleToken. One token per belt, `belt-{id}`, metadata title = belt name, media =
belt art URL. `nft_transfer` by the holder is allowed (a title can be gifted/sold); the new owner becomes the holder
(earns the champion share and defence credit from then on). Fighter cards (one NFT per forged sentence) are **optional**
(cut order); if built, mint to the writer on first forge.

## Views (JSON)
`get_config`, `get_belts`, `get_belt(id)` (incl. current season, holder, champion fighter, defences, reign_since,
defence_count top list), `get_fighter(hash_hex)`, `get_fighter_by_sentence(sentence)`, `get_challenge(id)`,
`get_pending(account)`, `get_fight(id)`, `get_fights(belt_id, from, limit)` (newest first), `balance_of`, `get_payouts(belt,
season)`, `get_allowlist` (+pending, activates_at), `preview_split(belt_id)`, `stats` (totals: tolls, protocol, challenges).

## Events (NEP-297, `standard:"titleshot"`, `version:"1.0.0"`)
`challenge`, `forge_requested`, `forged`, `rejected`, `refunded`, `rule_revealed`, `bout`, `title_change`, `season_opened`,
`season_closed`, `payout_created`, `payout_signed`, `deposit`, `withdraw`.

## Required tests (all must exist and pass; names must say the invariant)
Unit (native, `cargo test`): split conservation to the yocto over ≥1,000 random tolls/fees; purse split conservation + cap +
zero-challenge refund over ≥1,000 random seasons; self-dealing is strictly negative for any toll/fee; sentence cleaning;
nonce sequencing; payout value math.
Sandbox (`near-workspaces`, real wasm, **mock contracts** for `outlayer` (stores the request, lets the test resolve it with
a recorded output or a failure) and `mpc signer` (signs payloads with a test secp256k1 key so ecrecover passes)):
1 deposit/withdraw/storage; 2 FC key (receiver=contract, methods=[challenge]) can challenge but cannot withdraw,
nft_transfer, set_evm_address, open_season (assert failures); 3 full challenge → forged → bout (lose, win, draw) with
balances checked to the yocto; 4 callback failure / null / timeout via `expire_challenge` → refund minus fee; 5 tampered
response, wrong signer, unlisted signer, over-length response, refused verdict, unknown move → `Rejected` + refund;
6 double callback no-op, late callback after expiry no-op; 7 second challenge with the same sentence reuses the canonical
fighter (no compile requested); 8 self-challenge and champion's own sentence refused; 9 one pending challenge per account;
10 sealed rule revealed exactly once at the first bout; 11 close_season before bell refused, with pending refused, twice
refused, zero-challenge refund, split with caps, side-pot credit; 12 sign_payout nonce sequencing, idempotent re-sign, higher
fee re-sign, gas bounds, recovered-address check, claim_payout by payee only; 13 allowlist timelock; 14 relayer mode:
non-relayer refused, valid submit resolves; 15 NFT holder transfer then challenge pays the new holder.
Recorded real NEAR AI vectors go in `vectors/` (offline tests run without network or keys). Gas: report worst-case `challenge`
+ callback gas from the sandbox (target: callback ≤ 120 Tgas).
