# Basenames: payout identity on Base Sepolia

Season purses are paid on Base Sepolia to the EVM address each player registers with `set_evm_address`. Players can
now type a Basename (`yourname.basetest.eth`) instead of a 0x address, and payout recipients are shown by name.
No contract change: the name is resolved in the browser, and the contract still stores the address.

## Contracts used (Base Sepolia, chain 84532)

From [base/basenames](https://github.com/base/basenames) README, checked on chain 2026-11-14:

| Contract | Address | Role here |
|---|---|---|
| Registry | `0x1493b2567056c2181630115660963E13A8E32735` | `resolver(node)` for forward and reverse nodes |
| UpgradeableRegistrarController (proxy) | `0x82c858CDF64b3D893Fe54962680edFDDC37e94C8` | Registration. Both it and the legacy controller `0x49aE…9581` are BaseRegistrar controllers, but only this one is approved on the upgradeable resolver, so it is the live path. |
| UpgradeableL2Resolver (proxy) | `0x85C87e548091f204C2d0350b39ce1874f02197c6` | `addr`/`text` records of new names |
| L2Resolver (legacy) | `0x6533C94869D28fAA8dF77cc63f9e2b2D6Cf77eBA` | Primary names (`name(reverseNode)`), written by ReverseRegistrar `0x876e…841f` |
| ENS L2ReverseRegistrar | `0x00000BeEF055f7934784D6d81b6BC86665630dbA` | ENSIP-19 `nameForAddr`, fallback for primary names |

Reverse node: `namehash("<addr hex, lowercase, no 0x>.80014a34.reverse")` (coin type `0x80000000 | 84532`, equal to
`ReverseRegistrar.reverseNode()`; the upper-case form used by some libraries gives a different, empty node).

## How it works (`web/src/game/chain/basenames.ts`)

- **Forward**: normalise input to `label.basetest.eth` (ASCII a-z, 0-9, hyphen, 3 to 63 chars: unicode look-alikes are
  refused for payouts), `Registry.resolver(node)`, then `addr(node)`. Distinguishes "not registered" from "no address".
- **Reverse**: primary name from the legacy L2Resolver (ENSIP-19 registrar as fallback), **accepted only if that name
  resolves back to the same address**, so nobody can display someone else's name.
- Reads use the shared failover `Rpc` (sepolia.base.org, then publicnode). Results cached 30 s; network failures are
  never cached.
- Payout dialog (`PayoutAddress.tsx`): accepts `0x…` or a name, shows the resolved name and full address before
  saving, saves the resolved address with `set_evm_address`. A pasted address stays saveable if Base is unreachable.
  Logic is pure (`parsePayoutInput`, `resolvePayout`, `saveTarget`) and tested in `web/test/basenames.test.ts`.
- `BaseName.tsx`: `useBaseName(address)` and `<BaseName address>` (name, else short hex). Used in the payout dialog,
  the bell cinematic's payout rows, and Vance's Base wallet line on the Promoter screen.

## Velvet Vance owns a Basename through NEAR MPC

`scripts/vance-basename.mts` registers the name **from Vance's Chain Signatures address**: `vance.titleshot.testnet`
calls `v1.signer-prod.testnet.sign` (path `vance-purse`), the MPC network signs the EIP-1559 `register` transaction,
and the script checks the signature recovers to Vance's address before broadcasting. One transaction registers for one
year, sets the `addr` record and `description`/`url`/`avatar` text records, and makes the name Vance's primary name.
Spend cap 0.003 ETH (price plus worst-case gas, checked before signing); idempotent (stops if a primary name exists).

```
cd web && pnpm exec tsx ../scripts/vance-basename.mts --dry-run   # price, gas, cap check; nothing signed
cd web && pnpm exec tsx ../scripts/vance-basename.mts             # sign through MPC, broadcast, verify both ways
```

Live run, 2026-11-14 09:00Z:

| What | Link |
|---|---|
| Name | `velvetvance.basetest.eth` → `0xedc7423225a2afc44375cf36feffc4119b484d49` (forward and reverse verified) |
| MPC signature (NEAR) | [EU8Zyc9c…](https://testnet.nearblocks.io/txns/EU8Zyc9coX2GBXrrotCqkKjUpj1DayDqJwpA1LetpZk7) |
| Registration (Base Sepolia) | [0x60181a7b…](https://sepolia.basescan.org/tx/0x60181a7bc1519285d64938791b20f10fa9917ebee4633a346fdc119ad967ef0b) |
| Cost | 0.0000999 ETH name price + 671,869 gas at 0.0066 gwei ≈ 0.000106 ETH; Vance kept ≈ 0.01389 ETH for purses |

## What we do not claim

- The contract stores an address, not a name. Renaming or transferring a name later does not move a payout.
- Resolution is done by the player's browser against public Base RPCs; the contract does not check names.
- Testnet only (`basetest.eth`); Base Sepolia ETH has no value.
