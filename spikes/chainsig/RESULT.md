# Chain Signatures spike: NEAR contract pays Base Sepolia ETH with no key holder

Status 2026-11-14 (IST): everything works end to end up to the Base Sepolia broadcast. The final step (a mined Base Sepolia tx)
is blocked only by funding: no Base Sepolia ETH could be obtained (details under Funding). Once the derived address has ETH,
`PAYOUT_ID=1794600899062 npx tsx scripts/broadcast.ts` mines the already-signed tx (nonce 0, 0.0001 ETH).

## Addresses
| What | Value |
|---|---|
| Signer | `v1.signer-prod.testnet`, version `3.19.0` (view `version`), domain 0 = CaitSith secp256k1 "Sign" |
| Contract | `cs.titleshot.testnet` (owner `titleshot.testnet`), wasm 201,555 B, sha256 `5820246e1c3427a152346c5c230186f5eccca7361f449cb4f682472b112c9e2a`, balance ~2.13 NEAR (storage 201,857 B) |
| Path | `belt-1`, domain 0, predecessor = the contract |
| Derived key | `secp256k1:2Ar3HH6w2r5fix2npDg9BSUj9Bdsf8zzyQAk7JSScQMf4np4wbR1zv328hCzyS5ymgmPFeHwjYYMLpoV6wVfrtu7` |
| **Derived Base Sepolia address** | `0x18b9ea900d2a8891b135bf6614e1ef24e0c65ac7` (keccak(X,Y)[12..]; the contract also stores it and verifies every signature against it) |
| Funder wallet (PRIVATE_KEY in .env.local) | `0x6B9ad963c764a06A7ef8ff96D38D0cB86575eC00`, Base Sepolia balance 0 |
| Solana devnet analogue (domain 1, same path/predecessor) | `93uYb4eHU82SbfnMWvX7kirdir4eJf6qHKdzEGh3TpYR` |

## Signer schema (cited, not guessed)
Source: near/mpc `crates/contract/README.md` ("Submitting a signature request", "ECDSA signature response") and `crates/contract/src/api/sign.rs`
(`#[payable] pub fn sign(&mut self, request: SignRequestArgs)`); https://docs.near.org/chain-abstraction/chain-signatures/implementation.
- Request: `{"request":{"payload_v2":{"Ecdsa":"<64 hex = 32 bytes, must be < secp256k1 field p>"},"path":"belt-1","domain_id":0}}`. Legacy `payload` (32 ints) and `key_version` still parse.
- Deposit: >= 1 yoctoNEAR (excess refunded). Gas: the signer requires >= 10 Tgas attached; costs ~7 Tgas.
- Response (verified live on 3.19.0): `{"scheme":"Secp256k1","big_r":{"affine_point":"03<x:64hex>"},"s":{"scalar":"<64hex>"},"recovery_id":1}`. r = x of big_r (bytes 1..33), s is low-s normalised, the signed message is the payload as is (no further hash). The README warns that recovery returns some key even for forged sigs, so the contract checks the recovered address equals the derived address.
- `derived_public_key(path, predecessor, domain_id)` returns `secp256k1:<base58(X||Y)>`. Domains 0 and 4 are both CaitSith "Sign" keys, 1 and 5 Frost ed25519.

## What was built
- `contract/`: near-sdk **5.17.2** (see pitfalls), `omni-transaction` 0.5.0 (`evm` feature only). `sign_payout(payout_id, to, value_wei, nonce, max_fee_per_gas, max_priority_fee_per_gas, gas_limit)` is owner-only, builds the EIP-1559 tx (chain 84532), `keccak256(0x02 || rlp)`, calls `sign` with 1 yocto (40 Tgas) and `on_signed` (30 Tgas). The callback `ecrecover`s (malleability check on) and compares to the stored derived address, trims leading zeros of r/s (RLP integers), stores the raw tx under payout_id, emits NEP-297 `payout_signed`, returns `0x02...`. Same payout_id after success returns the stored tx with no new signature (`payout_replayed` event, 2.08 Tgas); same id with different params panics; same id while pending panics. Signer error or address mismatch: the callback soft-fails (clears Pending, event `payout_sign_failed`, returns null) so the payout can be retried. Views: `get_raw_tx`, `is_pending`, `get_address`, `preview` (unsigned bytes + digest).
- `contract/tests/spike.rs`: 10 offline tests against vectors made independently by `scripts/gen-fixtures.ts` (viem serialises, noble signs with a public test key): digest and unsigned bytes match viem, assembled raw tx byte-identical to viem including a vector whose s has a leading zero byte, replay, conflicting params, pending, non-owner, signer error then retry, wrong-key signature, high-s signature, input validation.
- `scripts/` (node + viem + near-api-js): `check-funds.ts`, `deploy.ts` (idempotent create/deploy/init/set_address), `payout.ts` (the full flow), `broadcast.ts`, `fund.ts`, `probe-sign.ts`, `gen-fixtures.ts`, `lib.ts`, `near.ts`.

## Evidence
- Unit tests: `10 passed; 0 failed` (command below).
- Live signer probe (direct call from titleshot.testnet, path `probe`): 7.7 s, 9.2 Tgas, https://testnet.nearblocks.io/txns/3zfbsnKdYuYY8VuLT3LrS3rUGauy79DB23QmTEgkgqBu
- **sign_payout (latest run)**: https://testnet.nearblocks.io/txns/FACnHdNqe5ap6FsJcrA1LSBVdFgeciZEB6DLCgUd39dJ . Call to signed raw tx **6.2 s** (other runs 6.2 to 8.4 s), **14.0 Tgas burnt** (about 0.0014 NEAR at 0.1 gigayocto per gas), 200 Tgas attached (unused gas refunded). payout_id 1794600899062. Earlier runs: 5r8kampMZ1JrZFoKGpvYcidcWqNcE2q2Wc9b9dVpRfFZ, JEDq2ZL5Qa9GYk7YTRVVzNwB8riq6BvRw7MuvGxeVCUB, AnYgBZ15yKHvC7njNXMwiEe6DqBG9VDLC8Kp6no1JzMv, 7VmkR9awfsU2YFskbJN4yinpT39ekmbQbxBgsPwUTZmo (all on testnet.nearblocks.io/txns/).
- Contract `preview` digest equals viem's `keccak256(serializeTransaction(...))`: `0x856f52b43e63e0003ea696ea04342ebb299022201bd7c0170d6820fc46c9611d`. `recoverTransactionAddress(raw)` = `0x18b9Ea90...0c65Ac7` = the derived address.
- Replay of the same payout_id: https://testnet.nearblocks.io/txns/BLxH2aDKmiokBkoUZDZfAFaBjBfMUSsKD7TFiiQ7VkJU : same raw tx, signer not called, 2.08 Tgas.
- Signed raw tx: `0x02f87183014a3480830f424083f42400825208946b9ad963c764a06a7ef8ff96d38d0cb86575ec00865af3107a400080c001a0e07a7cb78ca04a3a1ba5493172989182cee7bb8b91b9280deb4ec5066c74b39fa05386bb750ac07c046295dc9de393ce3e642288d956b0c835ae9dffd3fff701e2` (0.0001 ETH to the funder wallet, nonce 0, maxFee 0.016 gwei, prio 0.001 gwei, gas 21000).
- The Base Sepolia node accepted the tx structurally: broadcast failed only with `insufficient funds for gas * price + value: have 0 want 100336000000000` (it recovered the sender and checked its balance), so only ETH is missing.
- **NOT DONE: a mined Base Sepolia tx, its basescan link, and call-to-mined latency.** Base Sepolia blocks are 200 ms since 2026-10-21 (spectrumnodes.com blog), so mined latency should be dominated by the 6 to 8 s signing step.

## Funding (blocker, exact)
- `BASE_SEPOLIA_RPC_URL` (Alchemy) answers HTTP 403 `App is inactive. Please create a new app or contact support`; the scripts use public RPCs first (`sepolia.base.org`, publicnode, tenderly) and keep the Alchemy URL last. The Alchemy key in .env.local needs replacing.
- The PRIVATE_KEY wallet and the derived address both hold 0 Base Sepolia ETH.
- Faucets tried: Alchemy faucet (real Chrome via Claude in Chrome after agent-browser showed a Cloudflare Turnstile): `CAPTCHA verification failed. Please try again`, Send button stays disabled; not retried or solved. QuickNode faucet (agent-browser): `Insufficient ETH mainnet balance ... you'll need a small mainnet balance on this wallet`. Coinbase CDP, thirdweb, Chainstack, Optimism Superchain and Chainlink faucets need an account, API key or wallet login (not attempted, per the no-login rule); the pk910 Base Sepolia PoW host is unreachable; bwarelabs answers 530; learnweb3 503.
- Needed: about 0.002 ETH on `0x18b9ea900d2a8891b135bf6614e1ef24e0c65ac7` (0.0001 payout plus at most 0.0003 gas; more for several payouts). Anyone with a faucet login can drip to the funder `0x6B9a...eC00`, then `npx tsx scripts/fund.ts` sends 0.003 ETH, or drip straight to the derived address. Then `PAYOUT_ID=1794600899062 npx tsx scripts/broadcast.ts` (or `payout.ts`, which does everything with a fresh payout id).
- NEAR: root had 0.7 NEAR at the start, 10.7 after the coordinator top-up; the deploy cost about 2.14 NEAR. The account can be deleted later with near-cli-rs `delete-account` to `titleshot.testnet` to reclaim it (not done: the contract is still needed for the broadcast demo).

## Commands
```
# tests (CC/AR needed: the shell here wraps cc and ar, native secp256k1-sys/zstd-sys builds fail otherwise)
cd spikes/chainsig/contract && CC=/usr/bin/clang AR=/usr/bin/ar cargo test
# build (rust-toolchain.toml pins 1.86.0; --no-abi because ABI generation needs JsonSchema on callback types)
cargo near build non-reproducible-wasm --no-abi
cd ../scripts && npm i
npx tsx gen-fixtures.ts      # regenerate offline vectors (writes contract/tests/fixtures.json)
npx tsx check-funds.ts       # addresses and balances
npx tsx deploy.ts            # create cs.titleshot.testnet, deploy, init, set_address (idempotent)
npx tsx payout.ts            # sign_payout + verify + replay + broadcast (BROADCAST=0 to skip)
PAYOUT_ID=<id> npx tsx broadcast.ts   # broadcast a stored signed payout
```

## Fee strategy (measured)
Base Sepolia base fee 0.005 gwei, tips about 0. Use `maxPriorityFeePerGas = 0.001 gwei` and `maxFeePerGas = 3 x baseFee + prio` so the signed tx survives base-fee drift for minutes; a 21k transfer costs at most 0.0003 ETH worst case. The fee is part of the signed digest, so it is decided at sign time; the contract takes it as arguments (the relayer reads `eth_getBlock` / `eth_feeHistory`).

## Nonce management and stuck-tx advice for the real contract
1. One derived address per belt path, **one EVM nonce stream**: the real contract should own `next_nonce` and hand nonces out sequentially at `sign_payout` time (the spike takes nonce as an argument). Never sign nonce N+1 before N is signed; `eth_getTransactionCount(pending)` is only a relayer sanity check.
2. MPC signatures are **non-deterministic**: signing the same digest several times gave different (r, s, parity) each time (observed across runs). Two valid txs with the same nonce but different hashes can exist, and only one can mine. So sign once, store the raw tx (done), let any relayer broadcast it, and never re-sign the same (nonce, fees) as a "retry".
3. Replacement: if the stored tx sticks (fee too low), re-sign the **same nonce** with maxFee and maxPriority bumped by at least 12.5%, under an `attempt` counter, and mark the old raw tx superseded. Keep payout_id -> (nonce, attempt, raw) so a late mining of the old tx is recognised.
4. If a signed tx is dropped from mempools, rebroadcast the same bytes; the gap-free nonce stream means later payouts queue behind it. Never skip a nonce: sign a 0-value self-transfer at the stuck nonce to unblock.
5. Signer side: duplicate pending `sign` requests (same caller, domain, path, payload) are queued by the signer and all get one response; a signer timeout comes back as an error to `on_signed`, which soft-fails and clears Pending so the relayer can call again.
6. Gas: attach at least 50 Tgas to `sign_payout` (actual burn 14 Tgas, signer needs at least 10 Tgas attached; unused is refunded). The 1 yocto deposit comes from the contract balance.
7. Fund the derived address with a float, read `eth_getBalance` before signing and refuse a payout it cannot cover (the spike does not).

## Pitfalls found (relevant to the other lanes)
- **Rust 1.93 (the default here) cannot produce deployable wasm**: `cargo near build` refuses 1.87+ ("not compatible with nearcore VM"). Use toolchain 1.86.0 (already installed) with MSRV-aware resolution: `rust-version = "1.86"` plus `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback cargo generate-lockfile`; otherwise the newest near-sdk/near-sys demand rustc 1.95. near-sdk 5.17.2 is the version that resolves; keep Cargo.lock.
- `env::ecrecover` needs the near-sdk feature `unstable`; `cargo near build` needs `--no-abi` when callback args lack `JsonSchema`.
- near-api-js `Account.signTransaction` stalled on a second call in one process (cached nonce); `scripts/near.ts` signs with an explicit nonce read via RPC and polls `tx` with `wait_until: EXECUTED`. drpc's free tier kills `broadcast_tx_commit` (sign takes over 5 s): send with `wait_until: NONE` and poll.
- omni-transaction's `Signature{r,s}` are raw byte vectors that are RLP-encoded as strings, not integers: strip leading zeros (covered by the leading-zero vector, s = 0x0088dc...).
- Use omni-transaction with `default-features = false, features = ["evm"]`; the wasm is then 201 KB (about 2 NEAR of storage at 1e19 yocto per byte).
- A viem error on the Alchemy URL prints the API key; do not log raw viem errors from that transport.
- This shell exports `cc`/`ar` wrappers: native Rust builds that compile C fail unless `CC=/usr/bin/clang AR=/usr/bin/ar`.
- `scripts/` has a few TypeScript complaints under `tsc --strict` (protected `signTransaction`, a hex literal type); tsx does not type-check and runs them fine.

## Feasibility: Solana devnet via Chain Signatures (not built)
Feasible, and funding is easier than Base. Domain 1 (Frost Ed25519) signs raw message bytes (`payload_v2: {"Eddsa": "<hex, 32 to 1232 bytes>"}`, no hashing, no 32-byte limit), so the contract sends the serialised Solana message (the `omni-transaction` `solana` builder's `build_for_signing`) and attaches the 64-byte signature (response shape `{"scheme":"Ed25519",...}` to be verified live) to form the transaction. `derived_public_key(path, predecessor, 1)` returns `ed25519:<base58>`, which is directly the Solana address (`93uYb4eH...3TpYR` for belt-1). Funding is plain HTTP: `requestAirdrop` on `api.devnet.solana.com` (rate limited; `getHealth` returned ok today). Differences: no nonce but the recent blockhash expires in about 60 to 90 s, so sign right before broadcast and re-sign on expiry; the fee payer must be the derived key; `env::ed25519_verify` can check the signature in the callback; Frost latency is not measured. Rough effort for a transfer proof: half a day. Worth it only if the Base path is green and Solana adds a sponsor-track point.

## Update 01:55 IST — mined end to end (coordinator)
- Funding: 0.005 ETH to the derived address and 0.03 ETH to the funder from a testnet-only faucet wallet
  (https://sepolia.basescan.org/tx/0x40a697c2b272d5e162fa5fcd4521b50edc6cb100618c6150ebe3a05c8b6222d6).
- First broadcast (payout 1794600899062, gas 21000) mined but **reverted**: the recipient 0x6B9a…eC00 is an EIP-7702
  delegated EOA (code `0xef0100…`), so a 21k transfer runs out of gas. https://sepolia.basescan.org/tx/0x8068383593ca6f8bedced2e8602516668a6a136bf6a48122cfa36ec6de54e5c6
- Re-run with `GAS_LIMIT=60000` to a plain EOA: **success**.
  - sign_payout (NEAR): https://testnet.nearblocks.io/txns/5YRNw3d1SehmYN4373RYA9pGka8wHMryKKmtwxa3jfBZ (6.2 s, 13.99 Tgas)
  - Base Sepolia: https://sepolia.basescan.org/tx/0xdcf99b7fcd1b987daca12ccc691b020eb78109b261276f186ea60a7380cfc741 (broadcast→mined 1.0 s, total 14.3 s)
- Rule for the real contract: the payout gas limit is caller-supplied within bounds (≥ 21000, ≤ 150000), never fixed at 21000.
