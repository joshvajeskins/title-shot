# Forge spike result (OutLayer -> NEAR AI Cloud -> contract callback, NEAR testnet)

Status: **everything except the live NEAR AI call is proven on testnet.** `NEARAI_API_KEY` never appeared in
`.env.local` (checked at 01:20, 01:36, 02:07, 02:12, 02:17, 02:22, 02:45 IST), so the AI round trip x3 is **NOT RUN**.
What stands in for it: a public-endpoint round trip, the VRF round trip through the callback contract, the
secret reaching the TEE through the contract (placeholder key answered by NEAR AI with 401, handled, with the real 11.4 KB request body), and 30
host tests (18 forge, including the AI/signature flow over a mock transport, plus 12 contract tests).

## Deployed (testnet)

| Item | Value |
|---|---|
| OutLayer project | `titleshot.testnet/titleshot-forge` (uuid `p0000000000000183`) |
| Active version (wasm sha256) | `cc2020c92bcd28bbc8c6ed5b3c197bf2db6e200b494772ac1f650522a9a942e6` (forge 0.1.3, 480 KB: bout-sim request parts + chunked POST) |
| Earlier versions | `9da8c3a7...e8205` 0.1.0 (placeholder request, signature-doc rules missing), `18b7a3cd...b40dd` 0.1.1 (docs rules), `35f69fb1...ddfa0` 0.1.2 (bout-sim request, **traps on the 11 KB POST**) |
| FastFS | `https://test.fastfs.io/titleshot.testnet/outlayer.testnet/<sha256>.wasm` |
| Caller contract | `fc.titleshot.testnet` (spike, 155 KB wasm, 2.3 NEAR funded, create tx `2oDtvjJXQZtAD6sLbfEL1j2WvWgrdyAqAdZ7scqhy82v`) |
| Contract init | outlayer `outlayer.testnet`, model `anthropic/claude-fable-5` (placeholder, change with `set_model` from the contract key), VRF key pinned, forge_fee 0.01 NEAR |
| OutLayer VRF public key (testnet) | `c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8` (`GET https://testnet-api.outlayer.ai/vrf/pubkey`, equals `ping.vrf_pubkey` from inside the TEE) |
| Secret | profile `default`, project-bound, `--access allow-all --via fc.titleshot.testnet`, currently a **placeholder** value |

Explorer: `https://explorer.testnet.near.org/transactions/<tx>`.

## Evidence

| What | Tx | Result |
|---|---|---|
| TEE runs the forge (`ping`) | `6RadwmTSNJxp5fHX1fFnNPZ7ojq6VzHZxz5fvixphCkB` | 799 ms, 49k instructions, 0.001133 NEAR, `vrf_pubkey` returned |
| Outbound HTTPS from the TEE to `cloud-api.near.ai` (`GET /v1/models`, direct run) | `4yt8E5swTLKtjsJgRxfDtT6ES7Jftv1smrSmGccVGg8u` | status 200, 65,690 bytes fetched |
| VRF, direct run | `HEmDKJCTEMV9AEqdi5SppCnNvNtBcoX4uG7f5sVtkouf` | alpha `vrf:40461:titleshot.testnet:titleshot-challenge-7`; PyNaCl verifies the signature against the VRF key and `sha256(sig) == output_hex` |
| VRF through the contract, callback verifies on chain with `env::ed25519_verify` | `DF3eEa9oedQeFbs34dJY9hV3DfkCrsujkQEscjiaQtTx` | `forged (ok)`, request to callback 7.4 s, result 306 bytes, charge 0.001126 NEAR |
| same, more runs | `GJpKjBsV1mLVEarmPooiy1YPkXgQT12ArkbRJngDm6r2` (7.3 s), `5UsZ22jHRkjFd2TpQAZAnLkjyGPDJLiq3Go5iwRVJULz` (51.5 s, 0.0011228) | `forged (ok)` |
| Public endpoint through the contract (`forge_probe /v1/models`) | `488c25r6HbH4uLSZuHeJWJ1TVuwzNpYiFgRh63uYcTN8` | 198-byte result `{info,ok}`, 7.2 s, callback logs "no vrf" refusal (correct: a probe has no VRF) |
| Secret reaches the TEE through the contract; NEAR AI POST executed; error path | `DAx6xTv5tW7vGcEAssfjC1Peiixa49VFoYjEC14CQPxm` (v0.1.0), `FuYm2vWAYKBAJ2yVcpnJtmWcKXaFQFYfxP5RzrPFQnTr` (v0.1.1, 36 s) | `{ok:false,code:E_AI_STATUS,detail:"401 ... Invalid or expired API key"}` = placeholder key sent to NEAR AI, 163-byte result, `forge_refused` logged, refund sent |
| Stranger signer (not the secret owner) via the contract is admitted | `DMATK9ivSXLQiLtYWZC68jXij3n9UskCwmaA7jVdrxdK` | same 401 result (signer `fc.titleshot.testnet`) |
| Direct run naming the secret (not via the contract) is refused | `x7Wg6JA4qjxbdtbiAT1dfk5V4pgvtUPQriW39e2swpi` | `Access denied by access condition`, 0.001 NEAR charged, 0.002 deposit refunded |
| Null result path, live | `9eKHRPUz9E8xNNtM5BVwtj1VvxEsSnJvLoEUfdNK7cAc` (access-denied profile) | callback got `null`, logged `forge_refused: null result`, refunded the caller 0.049 NEAR |
| Large-body POST trap (0.1.2), found live | `FWBqpYj9EjqzELCz327MmxGUey7kEXpRb6pYEjJKVxW` | `Component execution failed ... wasm backtrace` after 909k instructions, callback got `null`, refunded; reproduced under wasmtime, fixed in 0.1.3 |
| 0.1.3 with the real 11.4 KB bout-sim request through the contract | `C3XPT9AxvKrUTZ3vA8kaJggVHAvfNHz9mZ9pJS5STutH` | body POSTed to NEAR AI from the TEE, `401 Invalid or expired API key` (placeholder key) returned as `E_AI_STATUS`, 955k instructions, 0.00118 NEAR |
| Yield timeout path, live | `Ae176JYiZWq4zHXMM7151hGxvBqNZsvSpvXbC7G4YYA7`, `F4xc56LTyZoTohGb3kTjkBiQikZrAwUdaJrUza12Z91A` | `Execution promise failed`, callback at +121 s / +123 s with a failed promise, refunded 0.049 NEAR |

## Measured numbers

- OutLayer cost per forge run (no AI, 25k instructions): **0.001123 to 0.001126 NEAR**; with the failing AI POST
  (162k instructions, placeholder body): 0.001137 to 0.001142 NEAR; with the real 11.4 KB request body (955k instructions,
  1.8 s): 0.001181 NEAR. Deposit 0.05 NEAR, the rest is refunded (0.0488 back). The spec's
  `forge_fee` of about 0.01 NEAR leaves 8x margin. A real AI run is network-bound (a few seconds of wall time, still
  well under 3M instructions), so expect about 0.0012 to 0.002 NEAR. **Not measured live: no key.**
- Request to callback latency (tx block to callback block), successful runs: 7.4, 7.3, 7.2, 10.5, 36.0, 51.5 s, then
  106.5 s (`C3XPT9...`, a run that completed 14 s before the timeout) later in the session. Latency is erratic, not a
  constant.
- OutLayer's yield timeout is **about 120 s** (callback at +119 to +123 s), not 200 blocks. A failed or trapped run can
  also come back as `null` after 98 s.
- Result sizes: VRF only 306 bytes; `ok:false` 163 bytes; AI result **not measured** (key). Estimate: chat completion
  JSON about 1.0 to 1.6 KB (fighter spec JSON about 400 B in `content`) escaped into a string, plus signature 132 B,
  text 100 to 140 B, vrf 306 B, address 42 B: **about 2.5 to 3.5 KB**, under the 4 KB target but not by much; keep
  `max_tokens` small (the placeholder request uses 400) and never use a reasoning model without `max_tokens` headroom.
- Contract callback gas: no failure at the 40 Tgas callback budget with 306-byte results; the AI-sized result is untested.
- Wasm sizes: forge 442 KB, contract 155 KB after `wasm-opt -Oz` (about 1.55 NEAR locked as storage).

## Findings that change the plan

1. **VRF seed format.** The brief's `titleshot:challenge:{id}` is impossible: OutLayer forbids `:` in the user seed.
   Use `titleshot-challenge-{id}`. Actual alpha: `vrf:{request_id}:{sender_id}:{seed}` (the SDK doc comment omits
   `sender_id`; the live output includes it). The contract can check suffix `:titleshot-challenge-{id}` and verify the
   ed25519 signature with the pinned key. It cannot know `request_id` in advance, so it cannot bind a specific
   OutLayer request; binding to the challenge comes from the promise callback plus the suffix.
2. **Secret access.** Default project secrets admit only the owner (judged on the transaction signer), so players would
   be refused. `--access allow-all --via <contract>` works: only calls arriving through the named contract open it,
   for any signer. Update `--via` (or `secrets access`) when the real game contract account is known.
3. **OutLayer instability.** Yield timeouts (callback fires with a failed promise about 120 s later) and 5 to 50 s latency
   variance were seen on 2026-11-14 IST 01:40 to 02:00. The soft callback and refund path worked in every case. The game
   must treat a failed or null forge as "refund minus fee and let the player retry", never as a lost challenge.
4. **First run after deploying a new version times out.** v0.1.1: three project runs in a row failed (01:41 to 01:51 IST)
   while the old version and a direct `--wasm` run of the same wasm worked, then it ran. v0.1.3: the first run after
   deploy failed with a yield timeout, the second worked. Cause not isolated (worker compile/cache). Burn one run after
   every deploy before a demo.
4b. **`wasi-http-client` 0.2.1 cannot POST a body over 4096 bytes in OutLayer (trap), and chunking alone deadlocks.** The real
   request is 11.4 KB. The forge now uses `src/wasi_post.rs` (start the request, then write 4 KB chunks). Found by the live
   trap, reproduced and fixed under `wasmtime run -S http` against the real API, then confirmed live (tx `C3XPT9...`).
   Anyone else POSTing large bodies from an OutLayer WASI app hits this.
5. **RPC for the CLI.** `outlayer` and `near` default RPCs 429 ("this client has exceeded the rate limit") under
   parallel agents; `near-testnet.drpc.org` queries fine but rejects `broadcast_tx_async` (`method is not available`).
   Worked: a local fallback proxy (query on drpc, broadcast on `test.rpc.fastnear.com`, strips intea's non-standard
   `note` field which breaks `near-jsonrpc-client`), exported as `OUTLAYER_RPC_URL` (`python3 -I scripts/rpcproxy.py 8911`; for `near` use a private config dir with `rpc_url = http://127.0.0.1:8911/` under `HOME=<dir>` so the shared near-cli config is untouched). `outlayer run` always blocks
   about 2 minutes regardless of the real round trip.
6. **Local toolchain traps.** `~/Documents/agents/bin/ar` shadows `/usr/bin/ar` and breaks `secp256k1-sys`/`zstd-sys`
   host builds of the contract tests: `AR=/usr/bin/ar CC=/usr/bin/clang cargo test`. The contract needs the pinned
   `Cargo.lock` copied from Stand-in's blocklist and `rust-toolchain.toml` 1.86.0 (newer near-sdk deps need rustc 1.88+).
7. **NEAR AI signature facts used** (from docs.near.ai, not yet seen live): `signature_kind` must be stated by the API
   and the text must match its rule (the forge refuses otherwise); `x-no-aliasing: true` on the completion;
   `/v1/signature/{id}` takes `signing_algo` and 404s until recorded (5 tries x 700 ms in the forge).
   Lowball's client used no `model=` on the signature call; the forge sends it only on the last try.

## Tests

- `forge`: 18 tests, passing on the host and inside wasm (`CARGO_TARGET_WASM32_WASIP2_RUNNER="wasmtime run -S http" cargo test --lib --target wasm32-wasip2`): body construction and escaping, input validation (length, control
  chars, model id, probe path allowlist), VRF seed has no `:`, signed-text rules, compact output shape, and the AI step
  through a mock transport: provider_tee and gateway accepted with exact response bytes kept, signature 404 retried,
  bounded retries with `model=` only on the last, 2xx+`error_code` is unavailable, text for other bytes or a missing or
  unknown kind refused, non-ecdsa refused, upstream error statuses reported, unsafe chat ids refused, run budget enforced.
- `fc` contract: 12 unit tests (`AR=/usr/bin/ar CC=/usr/bin/clang cargo test`): the **real recorded VRF proof** accepted
  and logged; AI fields noticed; null and failed-promise results are refusals that still refund; forge error codes
  reported; VRF for another challenge, a forged VRF from another key, and an output not equal to `sha256(signature)` are
  refused; malformed results never panic; fee and sentence guards; request carries `secrets_ref`, `response_format: Json`,
  the project id and the right input; request and callback receipts are scheduled.
- Live: see Evidence.

## Reproduce

```bash
# forge
cd forge && cargo test --lib && cargo build --target wasm32-wasip2 --release
export OUTLAYER_RPC_URL=<working RPC or the fallback proxy>      # see finding 5
outlayer upload target/wasm32-wasip2/release/titleshot-forge.wasm            # poll the FastFS URL until 200
outlayer deploy titleshot-forge <FastFS URL>
outlayer run titleshot.testnet/titleshot-forge '{"op":"probe","path":"/v1/models"}'
outlayer run titleshot.testnet/titleshot-forge '{"op":"forge","need_compile":false,"challenge_id":7}'

# contract
cd spikes/forge-callback && AR=/usr/bin/ar CC=/usr/bin/clang cargo test
cargo build --target wasm32-unknown-unknown --release && wasm-opt -Oz -o fc.wasm target/wasm32-unknown-unknown/release/forge_callback.wasm
near account create-account fund-myself fc.titleshot.testnet '2.3 NEAR' autogenerate-new-keypair save-to-legacy-keychain sign-as titleshot.testnet network-config testnet sign-with-legacy-keychain send
near contract deploy fc.titleshot.testnet use-file fc.wasm with-init-call new json-args '{"outlayer":"outlayer.testnet","project_id":"titleshot.testnet/titleshot-forge","model_id":"<NEAR AI model id>","vrf_pubkey_hex":"c0c5aeae1688c2f7cc2350aae1ee3ce96eddc0de84d678db873de48268f8cfa8","forge_fee":"10000000000000000000000","secrets_profile":"default","secrets_owner":"titleshot.testnet"}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction fc.titleshot.testnet forge_vrf_only json-args '{"challenge_id":1}' prepaid-gas '300 Tgas' attached-deposit '0.05 NEAR' sign-as titleshot.testnet network-config testnet sign-with-legacy-keychain send
near contract call-function as-transaction fc.titleshot.testnet forge_probe json-args '{"path":"/v1/models","challenge_id":2}' ...same flags
# measure request->callback latency, charge and size for any of those txs
python3 -I scripts/measure.py <tx_hash> [<tx_hash> ...]

# when NEARAI_API_KEY exists (never print it; pipe from .env.local):
outlayer secrets set "{\"NEARAI_API_KEY\":\"$(grep ^NEARAI_API_KEY= ../../.env.local | cut -d= -f2-)\"}" \
  --project titleshot.testnet/titleshot-forge --profile default --access allow-all --via fc.titleshot.testnet
near contract call-function as-transaction fc.titleshot.testnet set_model json-args '{"model_id":"<id>"}' ... sign-as fc.titleshot.testnet
near contract call-function as-transaction fc.titleshot.testnet forge json-args '{"sentence":"A baker who fights with rolling pins","challenge_id":21}' prepaid-gas '300 Tgas' attached-deposit '0.05 NEAR' sign-as titleshot.testnet ...
python3 -I scripts/measure.py <tx>      # expect forged (ok) with has_ai in the event, result_bytes about 3 KB
```

## Not run (and why)

- Live AI round trip x3 with real latency, cost and output size: no `NEARAI_API_KEY`.
- On-chain `ecrecover` of the returned signature: out of lane (`spikes/ecrecover`); the callback only reports `has_ai`.
- Mainnet, payment keys, attestation quote verification (OutLayer dashboard does it; not exercised here).

## Open risks

- Output size near the 4 KB target when the model's envelope is large (`usage` blocks, reasoning). Measure with the key; if
  over, the contract can accept `response` content-only only if the signature covered it, which it does not, so shrink with
  `max_tokens` or a smaller model instead of trimming the response.
- Gateway vs provider_tee: which kind the chosen model returns is unknown until a real call (the forge accepts both).
- Intermittent OutLayer yield timeouts: budget a retry/refund path and tell the player; keep the relayer fallback ready.
- A worker crash mid-run could in principle run the forge twice; only the first callback is accepted by the contract and
  the compile is a pure function of the sentence, so the effect is a second NEAR AI call, not a second result.
