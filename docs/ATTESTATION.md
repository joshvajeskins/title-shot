# Why trust the AI signer allowlist?

`ring.titleshot.testnet` accepts a compile only if the ECDSA signature recovers to an address in
`get_allowlist().active` (today `0x3b753b4406613c5e70ae640508632b600424fa0c`). The contract does not
check quotes itself. `scripts/verify-attestation.mjs` closes that gap off-chain: it independently checks
NEAR AI Cloud's hardware attestation for `z-ai/glm-5.3-flash` and ties it to the allowlisted address.

## What is checked

| Step | Check |
|---|---|
| a | Intel TDX quote of each model instance verifies against Intel's root of trust (Phala `dcap-qvl-node` 0.3.3, collateral from Intel PCS). TCB status reported; `Revoked` fails. |
| b | `report_data` parsed from the quote bytes (TDX v4, body offset 48 + 520): `[0..32]` = signer address, zero padded; `[32..64]` = request nonce. This is the layout in NEAR AI's reference verifier (`nearai/nearai-cloud-verifier`, `model_verifier.ts`). Cross-checked against dcap's parse. |
| c | `signing_address == keccak256(signing_public_key)[12:]`: the address derives from the attested key. |
| d | Live only: random 32-byte nonce sent, report must echo it (freshness). Offline: UNVERIFIED. |
| e | GPU evidence posted to NVIDIA NRAS; overall verdict true, NRAS JWT signature checked against NVIDIA's JWKS, GPU nonce equals the report nonce. |
| f | Event-log replay: RTMR3 recomputed from the dstack runtime events equals the quote's RTMR3; `sha256(app_compose)` equals the `compose-hash` event and `info.compose_hash`. So the compose file shown in the report is the code the CVM booted. |
| g | Live NEAR view `get_allowlist`: every active entry is an attested signer with a verified quote; no pending change reported as such. |

Overall is PASS only when all seven ran and passed; otherwise it lists the UNVERIFIED steps. Exit code is 1 on any FAIL.

## Run it

```
# one-time, outside the repo (no package.json edited)
mkdir -p ~/.cache/titleshot-attest && cd ~/.cache/titleshot-attest && npm init -y >/dev/null \
  && npm i @phala/dcap-qvl-node@0.3.3 @noble/hashes@1.8.0

node scripts/verify-attestation.mjs                  # live: 1 call to cloud-api.near.ai (public, no key needed),
                                                     #   Intel PCS, NVIDIA NRAS, NEAR RPC. Caches the full report.
node scripts/verify-attestation.mjs --offline        # no NEAR AI call; replays the cached full report
node scripts/verify-attestation.mjs --json out.json  # also writes the JSON; JSON is always printed last
```

Flags: `--contract`, `--model`, `--report <file>`. Env: `ATTEST_DEPS` (dependency/cache dir),
`NEARAI_BASE`. Missing dependencies give UNVERIFIED with the install line. If the endpoint ever
demands a key, the script reads `NEARAI_API_KEY` from `.env.local` and never prints it.

`vectors/attestation-z_ai_glm_5.3_flash.json` holds truncated fields (quote, key, GPU payload cut to 40
chars), so with only that file `--offline` can verify nothing cryptographic. Run live once; the full
report is cached in `~/.cache/titleshot-attest/` and later `--offline` runs replay it. To make offline replay work
from a fresh clone, commit that cached report (about 0.8 MB) as a vector and pass it with `--offline --report <file>`.

## Results

Live run (2026-11-14), 3 model instances returned:

```
a_tdx_quote      PASS        3/3 instances: TCB UpToDate; dcap-qvl-node 0.3.3, Intel PCS collateral
b_report_data    PASS        3/3: addr ok, nonce ok (report_data[0..32]=address padded, [32..64]=nonce)
c_key_address    PASS        3/3: keccak256(pubkey)[12:] = 0x3b753b4406613c5e70ae640508632b600424fa0c
d_nonce          PASS        3/3: report echoes our random nonce
e_nvidia_gpu     PASS        3/3: NRAS overall=true; nonce match; JWT signature valid
f_rtmr3_compose  PASS        3/3: RTMR3 replay of 10 events == quote; sha256(app_compose) == compose-hash
g_allowlist      PASS        active=[0x3b753b44..]; 1 attested signer, in allowlist, verified quote; no pending change
OVERALL: PASS
```

Offline replay of that cached report: identical except `d_nonce UNVERIFIED` (recorded nonce, no
freshness), so `OVERALL: INCOMPLETE (UNVERIFIED: d_nonce)`.

Observations: all 3 instances share one signing key and app id but differ in compose hash
(`c900dc73..`, `e8416a02..`, `a7de0bba..`). The compose files differ only in an instance label
(`gpu03/13/23`), and one points telemetry at a `-stg` endpoint. The gateway has its own signer
(`0xb98a789c..`); it is not part of this check.

## What remains trusted

- Intel (TDX root of trust, PCS collateral) and NVIDIA (NRAS, GPU attestation) as hardware roots.
- That the attested compose file and container digests do what NEAR AI says. Step f proves the CVM
  booted that exact compose; it does not audit the images (sigstore links for the digests are in the
  report's `app_compose`) or prove the model weights.
- That the key stays inside the CVM. The quote binds the address to the instance, not to a promise.
- The contract owner keeping the allowlist in sync with attested signers. A change is timelocked
  (`delay_sec` 3600, visible as `pending`), so it can be seen before it activates, but the contract
  does not verify a quote on-chain. Rerun this script after any allowlist change.
- Quote and TCB freshness is only as good as Intel's collateral at run time; `OutOfDate` TCBs are
  reported but not failed.
