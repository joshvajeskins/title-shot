# `titleshot` contract

Binding interface: `../docs/CONTRACT.md`. This file lists only how it was built and what that file leaves open.

## Build and test

```
./build.sh                       # contract/res/titleshot.wasm (Rust 1.86 via rust-toolchain.toml, cargo near, --no-abi)
cargo test --lib                 # native unit + mocked-chain flow tests (no sandbox, no network)
```
`build.sh` exports `PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang` so a shell script named `ar` can never run.
near-sdk is pinned to `=5.17.2` (feature `unstable` for `env::ecrecover`, `legacy` for the NFT collections); keep `Cargo.lock`.

## Layout (one concern per file, all under 300 lines)
| File | What |
|---|---|
| `lib.rs`, `types.rs`, `util.rs`, `codes.rs`, `events.rs` | state, records, helpers, stable `E_*` codes, NEP-297 events |
| `admin.rs`, `balances.rs`, `nft.rs` | init and owner setters, deposits, NEP-171 belts |
| `challenge.rs`, `resolve.rs`, `seed.rs` | challenge, OutLayer request, callback, relayer submit, expiry; AI signature, fighter, bout, split, belt; seed and VRF |
| `forge_out.rs` | **the only place that knows the forge/OutLayer output shape** |
| `verify.rs` | NEAR AI signature check (ported from `spikes/ecrecover`) |
| `season.rs`, `payout.rs`, `signer.rs`, `tx.rs` | seasons and the bell, Chain Signatures payouts (ported from `spikes/chainsig`) |
| `economy.rs` | pure rules: split, purse plan, sentence cleaning, payout value, nonce |
| `views.rs`, `tests/` | JSON views, tests |

## Forge output accepted (`forge_out.rs`)
`{ok:true, response, signature, signing_algo, signature_kind?, signing_address?, vrf:{output_hex, alpha?, signature_hex?}}`
or `{ok:false, code, detail}`. Extra fields are ignored. OutLayer may hand over the object or a JSON string holding it.
`null`, a failed promise, a non-object, `ok:false`, a missing `ok` and oversize (16 KB) output all refund (`Refunded`,
code `E_FORGE_FAILED` or `E_FORGE_OUTPUT`). A missing VRF in outlayer mode refunds with `E_VRF`.
`response`/`signature` may be absent only when the sentence's fighter is already stored.

## Decisions where CONTRACT.md is silent
- **Status in views** is flat: `{status: "Forging"|"Resolved"|"Rejected"|"Refunded", code?, detail?, fight_id?}`. `fight_id` is null for an opener.
- **Codes of soft paths** (stored, never panicked): `Rejected{E_AI_SIG}` for every signature-stage failure (the spike code is in `detail`),
  `Rejected{E_ENVELOPE|E_NO_CONTENT}` for a verified-but-malformed envelope, `Rejected{bout_sim code}` (`E_REFUSED`, `E_UNKNOWN_MOVE`, ...);
  `Refunded{E_FORGE_FAILED|E_FORGE_OUTPUT|E_VRF|E_TIMEOUT|E_SELF|E_CLOSED|E_SAME_SENTENCE|E_STATE}`.
- **Fee accounting.** Outlayer mode: the forge fee leaves the contract as the OutLayer deposit (`stats.fees_spent`); any unspent part OutLayer
  returns to the contract is not tracked. Relayer mode: nothing is spent, the fee is credited to the protocol balance at challenge time.
  Either way a refund is `toll - fee`. `protocol_balance` is withdrawn by `withdraw_protocol(to, amount?)` (owner, 1 yocto).
- **Belt ids start at 1**; `create_belt` mints `belt-{id}` to the promoter. A new season's opener moves the belt back to the promoter.
  `open_season` with an empty sentence carries the current champion (and holder) into the new season with no forge and no fee; a sentence whose
  fighter is already stored also opens immediately. Excess attached deposit is returned. Returns the season id.
- **Season states**: `Opening` (opener forging) -> `Open` -> `Closed`; a failed opener makes it `Aborted` and the promoter may open the next id.
  Challenges against an `Opening` season are `E_NO_CHAMPION`. `closes_at` counts from the moment the opener resolves.
- **Defence credit** is capped at 64 distinct accounts per season (further defenders still defend, they just earn no pro-rata share; the
  remainder rule sends their share to the final holder). Purse cap: each non-holder payee's pro-rata share <= 25% of the purse.
- **Pending challenge** is per account across belts. Opener challenges do not set it.
- **Seed**: `sha256("titleshot:seed:" ++ vrf_output ++ challenge_id_le)`. Relayer-mode challenges use `sha256(random_seed ++ challenge_id_le)` as the
  entropy and the event/fight says `seed_source: "block"`. If `set_vrf_pubkey` was called, the callback verifies the OutLayer VRF proof
  (ed25519 over `alpha`, output = sha256(proof), alpha must end `:titleshot-challenge-{id}`); otherwise only `output_hex` is used.
- **Extra owner setters** (all 1 yocto): `set_vrf_pubkey`, `set_forge_secrets(profile, owner)` (OutLayer `secrets_ref` for `NEARAI_API_KEY`),
  `set_request(model_id, req_prefix, req_suffix, signature_kind)` (emits the new hashes), `set_belt_media`, `withdraw_protocol`.
- **Withdraw** debits first, transfers, and a `on_withdrawn` callback re-credits if the transfer failed.
- Extra views: `get_season`, `get_payout`, `get_evm_address`; extra events: `belt_created`, `opener`, `season_aborted`, `purse_address`,
  `payout_claimed`, `payout_sign_failed`, `payout_sign_reset`, `allowlist_proposed|applied`, `request_changed`, `forge_mode`, `withdraw_failed`.

## Gas
`challenge` schedules `outlayer.request_execution` with 150 Tgas and `on_forged` with 60 Tgas; a client must attach >= 230 Tgas (300 is fine,
unused gas is refunded). `sign_payout` uses 40 Tgas for the signer and 30 Tgas for its callback (attach >= 80).
Measured in the sandbox on the real wasm (resolution = the same code the callback runs, via relayer `submit_forge`): `new` 5.2 Tgas,
`challenge` 4.5, `open_season` 4.2, **resolve (AI signature check + normalize + best-of-3 bout + split + belt) 7.8 to 9.2 Tgas over 8 bouts**,
opener resolve 6.2. The callback budget of 60 Tgas is therefore 6x the worst measured resolution.

## Known limits (honest)
- **Size**: ~626 KB wasm (about 6.3 NEAR of storage). serde_json is the largest part; typed views instead of `json!` would shave roughly 100 KB.
- **Payout gas (fixed after review)**: only the payee's own `sign_payout` parameters are used as given. Anyone else (the bell worker)
  can still sign a payout, but the max fee is lowered so `gas_limit * max_fee` stays within 1% of the payout, and the payee can replace such
  a tx with any parameters (even a lower fee). A stranger can never override a tx the payee signed (`E_NOT_PAYEE`). The payee replacing their
  own tx still needs a strictly higher fee. Re-signing keeps the nonce. A stranger-signed tx is cheap but may be underpriced if Base Sepolia
  fees spike above the clamp: the payee then bumps it.
- **Purse cap**: `open_season` refuses a purse above 1e24 wei (`E_AMOUNT`), so the purse plan cannot overflow and the bell always rings.
- **Purse address** freezes only once a payout is signing or signed, so a wrong address (first sign fails `recovered_address_mismatch`) can be corrected.
- **Relayer mode seed** is the block seed (weaker than the VRF).
- **Storage** of fighters, challenges and fights is paid by the contract's own balance (measured: about 1250 B, 0.0125 NEAR per bout with a
  new fighter; the OutLayer refund of an unused fee offsets part of it). Roughly 1000 bouts cost 5 NEAR of endowment. Guard added:
  `get_solvency` reports `endowment` (balance - storage staking - owed, where owed = deposits - withdrawn - fees spent - protocol withdrawn)
  and `deficit`; `withdraw_protocol` can only take the protocol share beyond the deficit, so the storage shortfall is paid from the protocol
  share before players are ever short. Top up the contract (about 5 NEAR per 1000 bouts) to keep the protocol share withdrawable.
- **Deploy gate**: `get_deploy_gates` lists unmet deploy conditions (VRF key not pinned, no secrets profile in outlayer mode, relayer mode).
  The sandbox cannot enforce them in code (its fake VRF has no key), so the deploy script must assert `ok == true` before the demo.
- **Owner trust points without a timelock** (documented, not a bug): `set_forge_mode`, `add_relayer`, `set_request`, `set_vrf_pubkey` take effect
  at once; only the signer allowlist is timelocked. The owner's full-access key can redeploy the contract anyway.
- **Yield payload (unverified live)**: nearcore refuses to resume a yield with a payload over 1024 bytes. OutLayer's documented large-output
  flow stores the output in its own state and resumes with metadata, but a forge output over 1 KB has not been run live; it needs one
  testnet forge and a real NEAR AI signature vector in `vectors/`. Relayer mode (`submit_forge`) is the fallback.
- **Small edge cases (bounded)**: a late MPC callback after `reset_payout_signing` plus a fresh higher-fee sign wastes one signature, no money
  moves; `MAX_DEFENDERS` (64) can be saturated by sybil defenders paying tolls; opener challenge ids are not in `get_pending` (read events).
