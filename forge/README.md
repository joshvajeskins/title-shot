# forge: the OutLayer WASI-P2 app

Runs inside OutLayer's Intel TDX workers, once per contract request. It compiles a sentence with
NEAR AI Cloud (secret API key from the OutLayer keystore), draws a verifiable VRF seed, and prints one
compact JSON object that the contract callback receives.

Project: `titleshot.testnet/titleshot-forge` (OutLayer testnet, owner `titleshot.testnet`).

## Input and output

Input (stdin JSON, tagged by `op`):

| op | fields | effect |
|---|---|---|
| `ping` | none | `{pong, version, has_key, vrf_pubkey}`: proves the TEE runs the code and sees the secret (boolean only) |
| `probe` | `path` in `{/v1/models, /v1/attestation/report}` | unauthenticated GET to `https://cloud-api.near.ai`: proves outbound HTTPS from the TEE |
| `forge` | `challenge_id` (u64), `need_compile` (bool), `sentence` (3 to 120 chars), `model_id` | VRF always; AI compile + signature when `need_compile` |

Output on success: `{ok:true, response, signature, signing_address, signing_algo, signature_kind, text, vrf:{output_hex, signature_hex, alpha}}`
(`ping`/`probe` return `info`; `need_compile:false` omits the AI fields). On any failure the app still
exits 0 and prints `{ok:false, code, detail}` so the callback gets a parseable answer. Codes:
`E_BAD_INPUT E_SENTENCE E_MODEL_ID E_PROBE_PATH E_VRF E_NO_KEY E_HTTP E_HTTP_BODY
E_AI_STATUS E_AI_UTF8 E_AI_NO_ID E_SIG_STATUS E_SIG_ALGO E_SIG_TEXT E_TIMEOUT`
(`E_SENTENCE` detail is the `bout_sim::Reject` code).
A run that OutLayer itself fails (access denied, worker gone, trap) reaches the contract as `null`.

## Rules the code enforces (each has a test in `src/tests.rs` or `src/compile_tests.rs`)

- Request body is `PREFIX ++ json_escape(sentence) ++ SUFFIX` from `bout_sim::rulebook` (path dependency on
  `../crates/bout-sim`, `src/request.rs` only re-exports), and the sentence check is
  `bout_sim::spec::check_sentence`, so forge, contract and browser agree byte for byte. The request is about
  11.4 KB (system prompt + strict json_schema).
- **POST bodies over 4096 bytes need the custom writer in `src/wasi_post.rs`.** `wasi-http-client` 0.2.1 traps
  (`blocking_write_and_flush` limit) and writing in chunks before starting the request deadlocks; the writer starts
  the request first, then writes 4 KB chunks. Found by running the component under wasmtime against the real API.
- The AI call sends `Authorization: Bearer $NEARAI_API_KEY`, `Accept-Encoding: identity`, `x-no-aliasing: true`,
  `stream:false`. The response bytes are kept exactly (the signature covers them) and returned as a string.
- Signature: `GET /v1/signature/{id}?signing_algo=ecdsa` (404 or 2xx with `error_code` = retry, 5 tries x 700 ms,
  last try also sends `model=`). `signature_kind` must be stated by the API and `text` must equal the rule for
  that kind: provider_tee `{model}:{sha256(req)}:{sha256(resp)}`, gateway `{sha256(req)}:{sha256(resp)}`.
  Anything else fails closed (`E_SIG_TEXT`). The forge does not recover the signer; the contract does.
- Chat id from the response is validated (`[A-Za-z0-9_-]`, 1 to 128) before it is put in a URL.
- Run budget 40 s (`E_TIMEOUT`); the caller sets OutLayer's `max_execution_seconds` (60 in the spike contract).
- VRF seed is `titleshot-challenge-{challenge_id}`. **The brief's `titleshot:challenge:{id}` cannot be used**:
  OutLayer builds `alpha = vrf:{request_id}:{sender_id}:{seed}` and forbids `:` in the seed. A verifier checks
  `ed25519_verify(vrf_pubkey, alpha, signature)` and `sha256(signature) == output`, then that `alpha` starts
  with `vrf:` and ends with `:titleshot-challenge-{id}`. The `request_id` and `sender_id` in the middle are
  injected by the worker, the guest cannot set them.
- Secret never printed; `ping` returns only `has_key: bool`. Nothing else reads `NEARAI_API_KEY`.

## Build, test, deploy (testnet)

```bash
cd forge
cargo test --lib                                   # 18 host tests, no network
CARGO_TARGET_WASM32_WASIP2_RUNNER="wasmtime run -S http" cargo test --lib --target wasm32-wasip2   # same 18, inside wasm
cargo build --target wasm32-wasip2 --release       # target/wasm32-wasip2/release/titleshot-forge.wasm (~440 KB)

# OutLayer CLI (~/.cargo/bin/outlayer). Credentials live in ~/.outlayer/testnet (login once; key piped, never printed):
#   outlayer login testnet     # account titleshot.testnet + its private key
export OUTLAYER_RPC_URL=https://near-testnet.drpc.org   # the CLI default RPC rate-limits; drpc cannot broadcast
#   (use a fallback proxy if broadcast fails: see spikes/forge-callback/RESULT.md "RPC")
outlayer upload target/wasm32-wasip2/release/titleshot-forge.wasm      # prints SHA256 and FastFS URL
outlayer deploy titleshot-forge <FastFS URL>                           # first call creates the project (attaches 0.1 NEAR, refunded)
outlayer run titleshot.testnet/titleshot-forge '{"op":"ping"}'
outlayer run titleshot.testnet/titleshot-forge '{"op":"probe","path":"/v1/models"}'
outlayer run titleshot.testnet/titleshot-forge '{"op":"forge","need_compile":false,"challenge_id":7}'
```

`outlayer run` from the CLI always waits about 2 minutes before it returns; the chain round trip is 6 to 50 s.
FastFS answers 404 for a freshly uploaded file for up to about a minute: poll the URL for 200 before `deploy`.
**Warm-up:** the first project run after deploying a new version times out (about 2 minutes, then the callback gets a
failed promise); the next run works. Seen on both clean observations (0.1.1, 0.1.3; 0.1.2 was masked by a trap and the
very first version ran at once). Burn one run after `deploy` (before a demo or a test) and expect a refund, not a result.

## Secret (NEARAI_API_KEY)

```bash
outlayer secrets set '{"NEARAI_API_KEY":"<key>"}' --project titleshot.testnet/titleshot-forge \
  --profile default --access allow-all --via fc.titleshot.testnet
```

`--access allow-all --via <contract>` means: the secret opens only for a call that arrives through that
contract (judged on the predecessor), for any signer, so players can call the contract and nobody can run
the project with the key directly. Verified live: a direct run naming the profile is refused
(`Access denied by access condition`). To change the allowed contract (the real game contract will not be
`fc.titleshot.testnet`): `outlayer secrets access ... --via <new contract>` (the value is not re-entered).
The contract passes `"secrets_ref": {"profile":"default","account_id":"titleshot.testnet"}` in
`request_execution`.

## Files

`src/lib.rs` modules: `input` (parse/validate), `request` (body), `compile` (AI step over an `Http` trait),
`output` (compact JSON, signed-text rule). `src/main.rs`, `ops.rs`, `net.rs`, `wasi_post.rs` are wasm-only glue
(`wasi-http-client` for GET, `wasi` for POST, `outlayer` SDK for VRF). `manifest.json` is embedded as the `outlayer.manifest` section.
