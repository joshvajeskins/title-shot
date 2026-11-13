// Offline vectors for the contract's unit tests: viem builds + serialises, noble signs with a fixed well-known test key.
import { serializeTransaction, keccak256, hexToBytes, bytesToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1";
import { writeFileSync } from "node:fs";

const PK = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318" as const; // public Hardhat-style test key, no funds
const addr = privateKeyToAccount(PK).address.toLowerCase();
const to = "0x1111111111111111111111111111111111111111";
const mk = (nonce: number) => ({
  type: "eip1559" as const, chainId: 84532, nonce, to: to as `0x${string}`, value: 1_000_000_000_000_000n,
  maxFeePerGas: 3_000_000n, maxPriorityFeePerGas: 1_000_000n, gas: 21_000n, data: "0x" as `0x${string}`,
});
function vec(nonce: number) {
  const tx = mk(nonce);
  const unsigned = serializeTransaction(tx);
  const digest = keccak256(unsigned);
  const sig = secp256k1.sign(hexToBytes(digest), hexToBytes(PK), { lowS: true });
  const r = sig.r.toString(16).padStart(64, "0");
  const s = sig.s.toString(16).padStart(64, "0");
  const yParity = sig.recovery & 1;
  const raw = serializeTransaction(tx, { r: ("0x" + r) as `0x${string}`, s: ("0x" + s) as `0x${string}`, yParity });
  return { nonce, unsigned, digest, r, s, recovery_id: sig.recovery, big_r: (yParity ? "03" : "02") + r, raw };
}
const plain = vec(7);
// High-s twin (n - s, flipped recovery): the same address recovers, but Ethereum (EIP-2) and env::ecrecover(malleability=true) reject it.
const N = secp256k1.CURVE.n;
const hs = BigInt("0x" + plain.s); const highS = (N - hs).toString(16).padStart(64, "0");
const high_s = { ...plain, s: highS, recovery_id: plain.recovery_id ^ 1 };
let n = 8; let zero = vec(n);
while (!(zero.r.startsWith("00") || zero.s.startsWith("00"))) zero = vec(++n);
const out = { address: addr, to, value_wei: "1000000000000000", max_fee: "3000000", max_prio: "1000000", gas_limit: 21000, chain_id: 84532, plain, leading_zero: zero, high_s };
writeFileSync("../contract/tests/fixtures.json", JSON.stringify(out, null, 1));
console.log("address", addr, "plain nonce", plain.nonce, "leading-zero nonce", zero.nonce, "r:", zero.r.slice(0, 6), "s:", zero.s.slice(0, 6));
