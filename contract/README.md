# `titleshot` contract

Binding interface: `../docs/CONTRACT.md`. This file lists only how it was built and what that file leaves open.

## Build and test

```
./build.sh                       # contract/res/titleshot.wasm (Rust 1.86 via rust-toolchain.toml, cargo near, --no-abi, then a wasm-opt size pass)
cargo test --lib                 # native unit + mocked-chain flow tests (no sandbox, no network)
REBUILD=1 THREADS=3 ./it/run.sh  # real wasm + outlayer-mock + signer-mock in near-workspaces (rebuilds mocks and the wasm first)
```
`build.sh` exports `PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang` so a shell script named `ar` can never run.
near-sdk is pinned to `=5.17.2` (feature `unstable` for `env::ecrecover`); keep `Cargo.lock`.

## Layout (one concern per file, all under 300 lines)
| File | What |
|---|---|
| `lib.rs`, `types.rs`, `util.rs`, `codes.rs`, `events.rs` | state, records, helpers (deploy gates), stable `E_*` codes, NEP-297 events |
| `store.rs`, `json.rs`, `hex.rs`, `b64.rs` | write-through storage map, tiny JSON writer for events/views, hex and base64 (each replaces a crate that cost wasm size) |
| `admin.rs`, `balances.rs`, `nft.rs` | init and owner setters, deposits, minimal NEP-171 belts |
| `challenge.rs`, `resolve.rs`, `seed.rs` | challenge, OutLayer request, callback, relayer submit, expiry; AI signature, fighter, bout, storage component, split, belt; seed and VRF |
| `forge_out.rs` | **the only place that knows the forge/OutLayer output shape** |
| `verify.rs` | NEAR AI signature check (ported from `spikes/ecrecover`) |
| `season.rs`, `payout.rs`, `signer.rs`, `tx.rs` | seasons and the bell, Chain Signatures payouts (ported from `spikes/chainsig`; the EIP-1559 RLP is hand written) |
| `economy.rs` | pure rules: split, storage component, purse plan, sentence cleaning, payout value, nonce |
| `views.rs`, `tests/` | JSON views, native tests |
| `it/` | sandbox tests t01-t22 (own workspace, newer toolchain) and `gas-report*.json` |
| `mocks/outlayer-mock`, `mocks/signer-mock` | test doubles; the OutLayer mock follows the real contract's source (below) |

## Forge output accepted (`forge_out.rs`)
`{ok:true, response, signature, signing_algo, signature_kind?, signing_address?, vrf:{output_hex, alpha?, signature_hex?}}`
or `{ok:false, code, detail}`. Extra fields are ignored. `null`, a failed promise, a non-object, `ok:false`, a missing `ok` and oversize
(16 KB) output all refund (`Refunded`, code `E_FORGE_FAILED` or `E_FORGE_OUTPUT`). A missing or unverifiable VRF in outlayer mode refunds with `E_VRF`.
`response`/`signature` may be absent only when the sentence's fighter is already stored.

## Large outputs (OutLayer)
Problem: nearcore refuses to resume a yield with a payload over 1024 bytes, and the real forge output (compile response + signature + VRF) is 2-4 KB.
Source read: `github.com/out-layer/outlayer`, commit `2d50bfa`, `contract/src/execution.rs` (docs page `app.outlayer.ai/docs/near-integration` describes the same API):

| Step | Source |
|---|---|
| `request_execution` pauses with `promise_yield_create("on_execution_response", ..., response_gas)` | execution.rs:323 |
| Worker, large output: `submit_execution_output_and_resolve` stores the output in the request's state, then resolves with `output: None` | execution.rs:393-427 (two-call variant `submit_execution_output` :372 + `resolve_execution` :434) |
| `promise_yield_resume` carries metadata only: "For large outputs, we only pass metadata through resume ... avoids the 1024 byte limit" | execution.rs:1073-1077 |
| `on_execution_response` takes the output from state when `output_submitted` (`Retrieving large output from storage`) | execution.rs:455, 474 |
| It hands the output to the caller with `env::value_return(&output_return_bytes(...))`: the stored JSON bytes as the callback's return value | execution.rs:702, 893-916 |
| A failed run, a failed promise and a timed-out yield all return `null`, never a failed promise | execution.rs:761, 792, 801 |
| The callback's gas: 50 Tgas minimum plus the unused gas by weight; output size is "covered by the weight share of whatever the caller left unused" | lib.rs:28, execution.rs:319-322, lib.rs:37-55 |

Consequence for this contract: **`on_forged` needs no special handling.** The caller's `.then(on_forged)` receives OutLayer's callback return value
as an ordinary promise result (limit 4 MiB, not 1 KiB), so `env::promise_result(0)` already holds the whole 3 KB output. `forge_out::parse_bytes` caps it at
16 KB (the AI response is capped at 8 KB by `verify.rs`). `Json` outputs come back re-serialized through `serde_json::Value`, i.e. with sorted keys;
the parser is order independent. The 120 s yield timeout arrives as `null` (`E_FORGE_FAILED`, refund minus fee).

`mocks/outlayer-mock` reproduces exactly that: `request_execution` yields to `on_execution_response`; the test-side "worker" answers through the real
operator API (`submit_execution_output`, `resolve_execution`, `submit_execution_output_and_resolve`) or the `resolve` helper, which picks the inline path
(<= 1024 resume bytes) or the stored path by size like the worker does; the callback refunds the unused deposit and `value_return`s the stored bytes.
Sandbox test `t22_large_output`: a 3.4 KB output is refused by `resolve_direct` (nearcore's limit), delivered by `resolve` through the stored path
(`resume_bytes < 1024`, `output_path: "stored"`), verified and resolved in the callback; a VRF-only output rides inline; 20 KB is refused softly (`E_FORGE_OUTPUT`).
NOT RUN: a live testnet forge over 1 KB (no NEAR AI key); the path is read from source and exercised on the mock, nothing more.

## Decisions where CONTRACT.md is silent
- **Status in views** is flat: `{status: "Forging"|"Resolved"|"Rejected"|"Refunded", code?, detail?, fight_id?}`. `fight_id` is null for an opener.
- **Codes of soft paths** (stored, never panicked): `Rejected{E_AI_SIG}` for every signature-stage failure (the spike code is in `detail`),
  `Rejected{E_ENVELOPE|E_NO_CONTENT}` for a verified-but-malformed envelope, `Rejected{bout_sim code}` (`E_REFUSED`, `E_UNKNOWN_MOVE`, ...);
  `Refunded{E_FORGE_FAILED|E_FORGE_OUTPUT|E_VRF|E_TIMEOUT|E_SELF|E_CLOSED|E_SAME_SENTENCE|E_STATE}`.
- **Fee accounting.** Outlayer mode: the forge fee leaves the contract as the OutLayer deposit (`stats.fees_spent`); OutLayer refunds the unused part
  to the contract when it settles (execution.rs "Refund excess NEAR payment"), which is not tracked and only adds to the endowment. Relayer mode: nothing is
  spent, the fee is credited to the protocol balance at challenge time. Either way a refund is `toll - fee - storage` (see "Storage"). `protocol_balance`
  is withdrawn by `withdraw_protocol(to, amount?)` (owner, 1 yocto). An opener's fee is attached by the promoter, so it is counted as money in
  (`stats.opener_fees`) and `owed()` stays exact (Opus review).
- **Storage component** (review fix): see "Storage" below.
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
  (ed25519 over `alpha`, output = sha256(proof), alpha must end `:titleshot-challenge-{id}`). **In outlayer mode `challenge` refuses with `E_NOT_READY`
  while no key is pinned** (below), so an unverified output can never seed a bout.
- **Extra owner setters** (all 1 yocto): `set_vrf_pubkey`, `set_forge_secrets(profile, owner)` (OutLayer `secrets_ref` for `NEARAI_API_KEY`),
  `set_request(model_id, req_prefix, req_suffix, signature_kind)` (emits the new hashes), `set_belt_media`, `withdraw_protocol`.
- **Withdraw** debits first, transfers, and a `on_withdrawn` callback re-credits if the transfer failed.
- Extra views: `get_season`, `get_payout`, `get_solvency`, `get_deploy_gates`; extra events: `belt_created`, `opener`, `season_aborted`, `purse_address`,
  `payout_claimed`, `payout_sign_failed`, `payout_sign_reset`, `allowlist_proposed|applied`, `request_changed`, `forge_mode`, `withdraw_failed`.

## Departures from CONTRACT.md / the first build (all in this pass)
- **NFT**: `near-contract-standards` replaced by a minimal NEP-171 core (`nft_transfer` with 1 yocto and holder-only, `nft_token`, `nft_tokens_for_owner`,
  `nft_total_supply`, `nft_metadata`, NEP-297 `nft_mint`/`nft_transfer`). Not implemented: approvals, `nft_transfer_call`/`nft_resolve_transfer`, `nft_tokens`, `nft_supply_for_owner`.
  Metadata is derived from the belt record. A marketplace that needs approvals or `nft_transfer_call` will not work with these belts.
- **Views and events** are written by `json.rs` instead of `serde_json::Value`: same fields, insertion key order instead of alphabetical; `get_fights`,
  `get_payouts`, `get_belts`, `nft_tokens_for_owner` return a JSON array like before. Fight views add `storage`, `storage_bytes`; `stats` adds `storage_charged`.
- **`get_evm_address` removed** (nothing used it; the payee's address is `get_payout.to` and the `payout_created` event).
- **`overflow-checks = false`** in the release profile (-19 KB). Every money or time sum is bounded by an explicit check (`MAX_TOLL` 1e30 yocto, `MAX_PURSE_WEI` 1e24,
  duration <= 30 days, gas and fee bounds, `purse*25` and `pool*n` far below `u128::MAX`), the property tests (5,000 tolls, 3,000 purses) and every native test run with
  overflow checks on, and the one user-controlled index sum (`get_fights`) saturates. A future change that adds unbounded arithmetic must add its own `checked_*`.
- **`new` / `set_request` byte strings** are decoded by `b64.rs` (standard alphabet, strict) instead of `Base64VecU8`; the JSON argument format is unchanged.
- **EIP-1559 RLP** is hand written in `tx.rs` (the `omni-transaction` crate is gone); the sandbox's independent EVM implementation (`it/src/evm.rs`) still decodes every signed tx.
- **Deploy gate** is enforced: see below. **Storage** is billed to the toll: see below.

## Storage is paid by the toll (review fix, MEDIUM)
Every challenge, fight and fighter is permanent state; before this pass the contract's own balance paid for it (about 0.0125 NEAR per bout). Now `challenge` measures
the bytes of the challenge record and pending flag, the callback measures the rest (fighter, fight, indexes, balance entries), and the sum is billed at
`env::storage_byte_cost()` out of the toll before the 60/25/10/5 split: `T = F + S + champion + promoter + side_pot + protocol`, exact to the yocto, with
`S = min(bytes x price, 50% of (T - F))`. `store.rs` writes through, so `env::storage_usage()` is exact at every point of a call. Measured: about 1,150 B
(0.0115 NEAR, 13% of a 0.1 NEAR toll) for a bout with a new fighter, about 600 B for a cached fighter. If the cap ever bites, the unbilled part is `stats.storage_debt`
(reported by `get_solvency`, never taken from players). A refunded or rejected challenge (Opus review) pays its storage the same way, out of its refund: its
record (about 400 B), plus the fighter when a compile was stored before a resolution guard (`E_SELF`, `E_VRF`, ...) refunded it; `get_challenge.storage_charge`
shows it. Nothing depends on how much of the fee OutLayer gives back. An opener has no toll: its bytes go to `storage_debt`. `get_solvency.equity` = balance - storage staking - owed;
`t21_storage_solvency` proves it does not fall over 11 bouts (9 new fighters, 2 cached) and over 6 failed forges, and that the bytes the bouts measured equal the account's real storage growth.

## Deploy gate (review fix, LOW)
`get_deploy_gates() -> {ok, ready, failing:[{gate, why, blocking}]}`. Blocking gates (`challenge` refuses with `E_NOT_READY`, nothing is debited): outlayer mode without a pinned
VRF key (`vrf_pubkey`), an empty signer allowlist (`allowlist`), unset request parts (`request`). Non-blocking, reported: no forge secrets profile in outlayer mode
(`forge_secrets`), relayer mode (`forge_mode`). The deploy script must still assert `ok == true` for a demo deploy. The sandbox rig now pins an ed25519 VRF key and grinds genuine proofs
(`simx::find_vrf`), so every sandbox bout verifies its VRF; `t20` covers the refusal and the recovery after `set_vrf_pubkey`.

## Gas
`challenge` schedules `outlayer.request_execution` with 150 Tgas and `on_forged` with 60 Tgas; a client must attach >= 230 Tgas (300 is fine,
unused gas is refunded). `sign_payout` uses 40 Tgas for the signer and 30 Tgas for its callback (attach >= 80). Measured gas tables: `it/gas-report.json`
(challenge tree and `on_forged`) and `it/gas-report-bell.json`; the table below is from the final run (sandbox, real wasm, debug test binary; tx tree = gas burnt over the whole receipt tree including the mock OutLayer).

| Path | tx tree (Tgas) | `on_forged` (Tgas) |
|---|---|---|
| `open_season` (opener compile, no fight) | 15.5 | 5.3 |
| `challenge`: compile + bout, champion wins | 19.2 | 8.5 |
| `challenge`: cached fighter + bout | 17.3 | 6.8 |
| `challenge`: compile + bout, title change (NFT moves) | 19.7 | 8.9 |
| `challenge`: tampered response -> refund | 15.3 | 4.5 |
| `challenge`: 3 KB forge output through the stored-output path | 19.9 | 8.8 |
| `close_season` / `sign_payout` | 4.5 / 18.7 | |

The 60 Tgas callback budget is about 7x the worst measured resolution (8.9); a 3 KB output adds under 0.3 Tgas over a 1.5 KB one. Not measured: the real
OutLayer settlement callback's own gas (it runs in OutLayer's contract, with 50 Tgas minimum plus unused gas by weight, so `challenge` leaves it roughly 70+ Tgas of the attached 300).

## Sizes
| Step | wasm bytes |
|---|---|
| Start (recovered tree) | 633,029 |
| NFT: hand-written NEP-171 instead of `near-contract-standards`, `legacy` feature off; views/events through `json.rs`; typed forge-output parse | 533,414 |
| Write-through `store::Map` instead of eleven `near_sdk::store::LookupMap` | 484,310 |
| `wasm-opt --converge --low-memory-unused` in `build.sh` | 443,455 |
| Hand-written EIP-1559 RLP (no `omni-transaction`), `to_ascii_lowercase` | 443,455 -> 443,379 |
| `overflow-checks = false` | 424,481 |
| Hand-written base64 (`b64.rs`) | 420,566 |
| String-wrapped forge output branch removed | 419,708 |
| `raw_value` feature for views (+2.4 KB), hand-written hex (-1.2 KB), shorter gate texts, `get_evm_address` removed (-1.5 KB) | **419,134** |

Final (after the Opus review fixes, +8.1 KB): `res/titleshot.wasm` 427,280 B (about 4.3 NEAR of storage), sha256 `1e12d6f3a51131f5aeae31ae309954aae54ab9f2b86e32f7398042ace2732283`. Biggest remaining parts (twiggy): the exported
methods (~130 KB, each carries its own argument decoding), `settle` 28 KB, the `f64` formatter 15 KB (serde error paths), `on_signed` 10 KB, `bout-sim`'s own `sha2` 7.5 KB.
Not reproducible-build: `build.sh` is `cargo near build non-reproducible-wasm` plus a local `wasm-opt` pass (Binaryen 133); a different Binaryen gives a different hash.
Test counts of the final run: native 54/54 (`cargo test --lib`), sandbox 66/66 (t01-t24).

## Known limits (honest)
- **Payout gas (fixed after review)**: only the payee's own `sign_payout` parameters are used as given. Anyone else (the bell worker)
  can still sign a payout, but the max fee is lowered so `gas_limit * max_fee` stays within 1% of the payout, and the payee can replace such
  a tx with any parameters (even a lower fee). The payee replacing their own tx still needs a strictly higher fee. Re-signing keeps the nonce.
- **Payout liveness (Opus review, HIGH)**: purse nonces are sequential, so one unmineable tx would block every later payout. The payee's own max fee
  must be at least 0.001 gwei (`E_GAS`), and 30 minutes after a nonce was first signed anyone may replace even a payee-signed tx at a strictly
  higher, still 1%-clamped fee (re-signing never restarts that clock). Shares below 0.00001 ETH are folded into the holder's payout at the bell so
  the clamp always leaves a realistic fee (>= 0.0048 gwei at 21000 gas). Left open: if Base Sepolia's base fee stays above a payout's 1% clamp,
  only its payee can pay more; a payee re-signing a lower fee over a stranger's tx is allowed (the stranger's higher-fee tx was broadcast first).
- **Payee privilege without a deposit (LOW, not reachable today)**: `sign_payout` treats the caller as the payee by account alone. A function-call key
  with an empty method list would carry that privilege; guest keys are `["challenge"]` only. Requiring 1 yocto for the payee path would change
  the worker and test interface, so it is left documented.
- **Purse defence farming (LOW, documented)**: a holder's own sybil challenges that lose count as defences and move part of the pro-rata half
  of the purse (each account still capped at 25%). The "self-dealing is strictly negative" property covers the NEAR toll only, not the purse.
- **Purse cap**: `open_season` refuses a purse above 1e24 wei (`E_AMOUNT`), so the purse plan cannot overflow and the bell always rings.
- **Purse address** freezes only once a payout is signing or signed, so a wrong address (first sign fails `recovered_address_mismatch`) can be corrected.
- **Relayer mode seed** is the block seed (weaker than the VRF).
- **Owner trust points** (Opus review): `set_request` and `set_forge_mode` are now staged behind the allowlist timelock and applied by
  `apply_config` (a request change also waits for no forging challenge). Still instant: `add_relayer` (only acts on relayer-mode challenges,
  and switching to relayer mode is timelocked), `set_vrf_pubkey`, `set_forge_secrets`. The owner's full-access key can redeploy the contract anyway.
- **VRF binding**: with a pinned key the alpha must name this contract as sender; OutLayer's request id is checked for shape only (the contract
  does not learn it), and the forge `version_key` is not pinned.
- **State layout changed** in this pass (new fields on `Contract`, `Stats`, `Challenge`, `Payout`, `SignedTx`): deploy to a fresh account,
  never over an existing initialised one.
- **Small edge cases (bounded)**: a late MPC callback after `reset_payout_signing` plus a fresh higher-fee sign wastes one signature, no money
  moves; `MAX_DEFENDERS` (64) can be saturated by sybil defenders paying tolls; opener challenge ids are not in `get_pending` (read events).
- **Not done**: the float formatter (`core::fmt` for `f64`, ~15 KB) stays in the wasm because serde's error paths reference it; the `bout-sim` crate's own `sha2` (~7.5 KB)
  could use the host `sha256` and `serde_json::Value` could leave `bout_sim::rulebook` (sim lane); either would shrink the wasm further.
