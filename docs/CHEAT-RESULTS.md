# The contract refuses cheats (live, testnet)

Run 2026-11-14T09:45:47.622Z by `scripts/cheat.mjs --go` against `ring.titleshot.testnet` in relayer forge mode. Test challenger `cheat.titleshot.testnet`
challenged belt 1 "The Midnight Belt" (season 2, toll 0.0500 NEAR, forge fee 0.0100 NEAR); the listed relayer
`relay.titleshot.testnet` delivered each forged result with `submit_forge`. The contract rebuilds the NEAR AI request from the challenge's own
sentence, hashes the delivered response, recovers the EIP-191 signer with `ecrecover` and checks the timelocked allowlist
(`0x3b753b4406613c5e70ae640508632b600424fa0c`). Genuine responses are recorded real NEAR AI vectors (`vectors/nearai-real-*-low.json`).

| case | what the relayer delivered | tx (submit_forge) | contract code | refund |
|---|---|---|---|---|
| a | genuine signed response, one byte of the fighter JSON changed — challenge #8; byte 684 of the signed response: `"power":6` → `"power":9` | [Cnmh5urE…](https://testnet.nearblocks.io/txns/Cnmh5urEDPyC7ouKdy4oxcc7P8FomCR9yTxaymqge6Qq) | `E_AI_SIG (E_SIGNER)` | 0.0374 NEAR back = toll 0.0500 − fee 0.0100 − storage 0.0026 (264 B) ✓ |
| b | genuine signed response for another sentence ("a cactus who runs a lemonade stand in a heatwave") — challenge #9; untouched NEAR AI response + signature | [DQDXgmeD…](https://testnet.nearblocks.io/txns/DQDXgmeDByFuvrzo4ffQFbsKPAvRUhJnesq9bhPFBPBQ) | `E_AI_SIG (E_SIGNER)` | 0.0374 NEAR back = toll 0.0500 − fee 0.0100 − storage 0.0026 (260 B) ✓ |
| c | right message format, signed by a random non-allowlisted key — challenge #10; signer 0x8b0f0e43… (random key), all weights 10 | [5EZFVkNE…](https://testnet.nearblocks.io/txns/5EZFVkNEDxREDkty5bmNHfLZgrgTujJ1fjoACuvDnmiJ) | `E_AI_SIG (E_SIGNER)` | 0.0374 NEAR back = toll 0.0500 − fee 0.0100 − storage 0.0026 (263 B) ✓ |
| d0 | control: the genuine signed result, delivered once — challenge #11; untouched NEAR AI response + signature | [217pLZZF…](https://testnet.nearblocks.io/txns/217pLZZFPeGqxseobW2sg6nB6KZZDKhtzzukqxWc8EyK) | `accepted: Resolved, bout #1, winner champion` | none: toll 0.0500 NEAR paid into the bout split |
| d | replay: the same result delivered again for challenge #11 | [9zxVTFWD…](https://testnet.nearblocks.io/txns/9zxVTFWDUzcdsk1eW3L4VwdRox4d41hk5AUjoejSxYqS) | `E_NOT_FORGING` | none: balance unchanged (0.1071 NEAR), challenge stays Resolved |

`E_AI_SIG` is the challenge's terminal status (`get_challenge` → `Rejected`), with the verifier's own code in brackets
(`E_SIGNER`: the recovered address is not on the allowlist). A refusal refunds the toll minus the forge fee and the storage the
refused challenge leaves behind (docs/CONTRACT.md). `E_NOT_FORGING` is a panic of `submit_forge`: a settled challenge cannot be
settled again, so no second bout, payout or refund happens.

Setup: \`cheat.titleshot.testnet\` created by near-cli with 0.3 NEAR from \`titleshot.testnet\`
([3he9qrYj…](https://testnet.nearblocks.io/txns/3he9qrYj1FmxYE8BpQi3aT8BQ7JLfXm6TCTURTWAtZpR)), then \`deposit\` 0.2 NEAR (game balance
0.195 after the 0.005 account storage). Cost of the whole run to the challenger: 0.0879 NEAR of game balance (3 × 0.0126 kept by
refusals + one 0.05 toll in the real bout) plus gas; game balance left 0.1071 NEAR.
