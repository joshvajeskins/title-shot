# ecrecover spike: result

Status: the contract-side proof is DONE and passing (synthetic EIP-191 vector, 27 cases, three independent implementations agree). The real NEAR AI vector is NOT RUN: `NEARAI_API_KEY` was absent from `.env.local` at every check. The recorder is ready and was exercised end to end against a local mock.

## What was built
| Path | What |
|---|---|
| `spikes/ecrecover/contract/` | near-sdk 5.27 contract (`src/lib.rs`, `src/verify.rs`, `src/tests.rs`), `build.sh`. wasm = 129 KB |
| `spikes/ecrecover/it/` | own workspace: `src/bin/gen_vectors.rs` (vector generator), `tests/sandbox.rs` (near-workspaces, real wasm) |
| `spikes/ecrecover/scripts/` | `record-vector.mjs`, `verify-offline.mjs`, `lib.mjs`, `mock-nearai.mjs`, `attest-summary.mjs`, `gen-escape-cases.mjs` |
| `vectors/synthetic-eip191-1.json` | generated vector (no key stored: throwaway key is random per run and discarded) |
| `vectors/escape-cases.json` | node `JSON.stringify` reference for `json_escape` |
| `vectors/attestation-*.json` | recorded public attestation summaries (signers, TEE presence) |
| `spikes/ecrecover/gas-report.json` | per-case gas from the sandbox |

## Contract interface (as specified)
`init(allowlist: Vec<String>, prefix: Base64VecU8, suffix: Base64VecU8, model_id)`; `get_config()`;
`verify_forge(sentence, response, signature_hex, signing_algo, signature_kind) -> {ok, code, signer, content, request_sha256, response_sha256}`.
Never panics on bad input. Check order: algo (`ecdsa` only) -> kind -> sentence cap (1024 B) -> response cap (8 KB) -> sig hex/len/v -> rebuild `req = prefix ++ json_escape(sentence) ++ suffix` -> text per kind -> EIP-191 digest (keccak host fn) -> `env::ecrecover(digest, rs, v, malleability_flag=true)` -> keccak[12..] in allowlist -> parse `choices[0].message.content` (only after the signature is verified, so the returned content is attested bytes).
Stable codes: `OK E_ALGO E_KIND E_SENTENCE_SIZE E_RESPONSE_SIZE E_SIG_HEX E_SIG_LEN E_SIG_V E_RECOVER E_SIGNER E_ENVELOPE E_NO_CONTENT`.
Notes for the game contract: needs `near-sdk` feature `unstable` (ecrecover is gated behind it). `E_SIGNER` covers both "signed a different text" (tampered response/sentence/model id/kind) and "not allowlisted"; `signer` in the output tells them apart for debugging. `signer` and the two hashes are returned even on failure.

## Evidence (all run after the last edit)
- Native unit tests: `cargo +1.86.0 test` in `contract/`: **4 passed** (all 27 vector cases against the contract logic, json_escape == node JSON.stringify on 12 tricky strings incl. quotes, control chars, emoji, U+2028; sig decoding; init guards).
- Sandbox with real wasm: `cargo test` in `it/`: **2 passed**. Every one of the 27 cases checked both as a view and as a real transaction; plus init guards (bad address, empty allowlist, double init all rejected).
- Offline node (noble, independent crypto): `node scripts/verify-offline.mjs` -> `OK 39/39` (27 cases + 12 escape cases).
- Cases covered: valid provider_tee (v 27/28, v 0/1, 0x + uppercase hex), valid gateway text, unicode/escaped sentence; tampered response byte, trailing newline, tampered sentence, different model id signed, signer not allowlisted, gateway sig as provider_tee and the reverse; high-s malleable twin (-> `E_RECOVER`), zero r/s, truncated 64 B and 66 B sig, bad v (2, 29), non-hex, ed25519, unknown kind, sentence > 1024 B, 9 KB validly-signed response (-> `E_RESPONSE_SIZE`), validly-signed non-JSON / empty choices / null content / empty content.
- **Gas** (total gas burnt per transaction, 5982 B prefix + 938 B suffix, i.e. a rulebook-sized request): valid path **2.38 Tgas** (budget < 15); tampered/not-allowlisted 2.31; high-s/zero sig 2.28; early rejects 1.64-1.83. Real-shaped mock vector: 1.95 Tgas. The cost split was not profiled (the numbers include the ~7 KB state read and the JSON parse); the gap between valid and early-reject paths is only ~0.7 Tgas.
- Only host functions are used for crypto (sha256, keccak256, ecrecover); no Rust crypto crates are linked.
- Recorder end-to-end vs local mock (`mock-nearai.mjs`): recorded vector verified offline (OK) and in the sandbox on the real wasm (7 cases pass incl. key-free derived negatives, 1.95 Tgas).

## Real NEAR AI Cloud facts recorded (public endpoints, no key)
`GET /v1/models` lists ~55 ids. `GET /v1/attestation/report?model=<id>&signing_algo=ecdsa` (0.4-1 s; 3.8 s for kimi-k3):
- TEE-attested by NEAR AI (Intel TDX quote + NVIDIA payload, own `signing_address` per model): `Qwen/Qwen3.8-27B` (0x835ab53d20294ef795906dff21ae4c045336aa26), `Qwen/Qwen3.6-35B-A3B-FP8` (0xfdbd7952498b333206f360d71d97a1e0961e8ddf), `Qwen/Qwen3-VL-30B-A3B-Instruct` (0x2665cce942fa427ef30d87f4b0bff67fb7645462), `z-ai/glm-5.3-flash` (0x3b753b4406613c5e70ae640508632b600424fa0c), `deepseek-ai/DeepSeek-V4.1-Flash-1017` (0xfe0071895500a9755c18044948ab4f4e1a7f337e), `Qwen/Qwen3.8-27B-abliterated` (0x979121f480a3c974b80cb37b81423ddc37093474; do not use for a game).
- Gateway signer (the same for every model, `gateway_attestation`): 0xb98a789cdc4817275f5155593ba73ef2a957e779.
- NOT TEE (503 "external providers run outside our TEE"): `deepseek/deepseek-v4.1-flash`, `openai/gpt-6.1-sol` (all OpenAI/Anthropic/Google ids are external providers). `moonshotai/kimi-k3` ("attested 3p") returns a report with no quote/payload.
- `/v1/models` `supported_features` for TEE open-weight models: `Qwen/Qwen3.8-27B` tools, structured_outputs, reasoning (is_ready true); `Qwen/Qwen3.6-35B-A3B-FP8` tools, json_mode, structured_outputs, logprobs, reasoning (ready true); `z-ai/glm-5.3-flash` tools, structured_outputs, reasoning, json_mode (ready true); `deepseek-ai/DeepSeek-V4.1-Flash-1017` tools, reasoning only (no structured_outputs); `Qwen3-VL-30B-A3B-Instruct` structured_outputs, logprobs.
- Multi-replica models (`z-ai/glm-5.3-flash`, DeepSeek-V4.1-Flash-1017) return several `model_attestations` entries; all showed the same address, but the allowlist supports up to 8 so replica keys can be added.
- Docs (response-signature-verification): gateway text `sha256(req):sha256(resp)`, model-prefixed `<model>:<sha256(req)>:<sha256(resp)>`; hash the exact bytes; ECDSA = 65-byte sig + EIP-191 personal sign; hex may carry `0x` (the contract accepts both). The `GET /v1/signature` and `signature_kind` pages were not retrievable (404 on the chat-verification path), so which kind each model returns is UNVERIFIED until the real run.

## Real vector: NOT RUN
Reason: `NEARAI_API_KEY` is not in `.env.local` (checked at start, after the contract build, and at the end). Everything else for it is ready. When the key lands, from the repo root:
```
cd spikes/ecrecover && npm install
for m in "Qwen/Qwen3.8-27B" "Qwen/Qwen3.6-35B-A3B-FP8" "z-ai/glm-5.3-flash"; do
  node scripts/record-vector.mjs --model "$m" --n 1        # optional: --parts <json of bout-sim request_parts(model)>
done
node scripts/verify-offline.mjs                              # all vectors, independent implementation
cd it && cargo test -- --nocapture                           # real wasm on every vector (needs contract/build.sh first)
```
The recorder prints, per model: `signature_kind`, whether the request hash equals sha256 of the exact bytes sent, response hash equality, whether the signer matches the attested model/gateway address, completion latency, signature-fetch latency/attempts, whether the strict json_schema output parsed. It exits non-zero if the signature does not verify offline (vector is still saved for diagnosis). Decision to take from the output: pick the model whose report shows `signature_kind: provider_tee`, `request_hash_equals_sha256_of_sent_bytes: true`, `json_schema_strict_ok: true` and the lowest latency; put `signing_address` in the contract allowlist. Default recommendation until then: `Qwen/Qwen3.8-27B` (TEE-attested, structured_outputs, reasoning, cheapest at $0.04/$1.35 per M).

## Reproduce (everything that ran)
```
export PATH=/usr/bin:$PATH AR=/usr/bin/ar            # REQUIRED on this machine, see risk 1
node spikes/ecrecover/scripts/gen-escape-cases.mjs
(cd spikes/ecrecover/it && cargo run --bin gen_vectors -- ../../../vectors)   # regenerates the vector with a fresh random key
(cd spikes/ecrecover/contract && cargo +1.86.0 test && ./build.sh)
(cd spikes/ecrecover/it && cargo test -- --nocapture)
(cd spikes/ecrecover && npm install && node scripts/verify-offline.mjs)
node spikes/ecrecover/scripts/attest-summary.mjs "Qwen/Qwen3.8-27B"
```
`contract/Cargo.lock` was seeded from `near-lowball/contract/Cargo.lock` (fresh resolution picks near-sdk-env 0.1.9, which needs rustc 1.95 and breaks the 1.86 build; commit the lock). The contract must build with Rust 1.86 (nearcore VM rejects newer wasm); `it/` uses stable.

## Risks and recommendations
1. **Machine hazard (action needed by the coordinator and Gabriel).** `~/Documents/agents/bin/ar` (a legacy fleet "remote-only mode" script) shadows `/usr/bin/ar` on PATH. Any C build via the `cc` crate (ring, aws-lc-sys, pulled in by near-workspaces) invokes it. During my first `cargo run` it ran at least once: it overwrote `~/Documents/agents/.fleet-mode` and the `comms.db` `fleet_state.mode` row to `remote` (file mtime 14 Nov 01:19:45 IST), and its Edge Config step may have PATCHed Vercel `fleet_mode` with the vault token. The previous mode value is unrecoverable from what I could read; the old agent processes were already dead (pid files from June). I did not try to restore anything. Every later build ran with `PATH=/usr/bin:$PATH AR=/usr/bin/ar` and the mtime did not change again. All other lanes that compile Rust C deps (forge/OutLayer, sim with wasm-bindgen is unaffected) must do the same, and Gabriel may want to rename that script.
2. The signature kind per model and whether NEAR AI hashes the exact bytes we send (vs a re-serialized body) is the one open fact. If the request hash does not match sha256 of the sent bytes, the whole "contract rebuilds the request" binding must change (fallback: contract verifies only the response hash and the sentence is bound inside the model's own output; discuss before building on it). The recorder reports this directly.
3. `json_escape` equals JS `JSON.stringify` on all tested inputs (12 incl. emoji, U+2028, control chars); serde_json and JSON.stringify both leave DEL and U+2028 raw and use lowercase `\u00xx`. The forge (Rust) and the web preview must use the same escaper; lone surrogates cannot occur in Rust strings.
4. Reasoning models may return `content: null` with reasoning elsewhere: the contract returns `E_NO_CONTENT`; the forge should use a non-reasoning/`reasoning off` configuration or `max_tokens` large enough to finish.
5. Response cap 8 KB; a fighter spec JSON is ~400 B, so there is margin, but a model that echoes reasoning in the envelope could exceed it.
6. Signer rotation: the model signing key lives in a TEE and may change on redeploy; the game contract needs the admin-set, timelocked allowlist update from the architecture doc, plus a way to add replica keys.
7. `signing_algo=ed25519` is rejected (`E_ALGO`); `env::ed25519_verify` could be added if NEAR AI ever returns it for the chosen model.
