// End to end: sign_payout on NEAR testnet -> raw EIP-1559 tx -> local verification -> broadcast to Base Sepolia -> receipt.
// Env: PAYOUT_ID (default: now), TO (default: PRIVATE_KEY wallet), VALUE_WEI (default 100000000000000 = 0.0001 ETH), BROADCAST=0 to skip.
import { writeFileSync } from "node:fs";
import { formatEther, parseGwei, keccak256, parseTransaction, recoverTransactionAddress, serializeTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeAccount, callAndWait, logsOf, gasBurnt, successValue } from "./near.ts";
import { env, baseClient, nearView, SIGNER, CONTRACT, ROOT_ACCOUNT, PATH, DOMAIN, evmAddressFromNearKey, nearLinks, baseLink } from "./lib.ts";

const key = await nearView(SIGNER, "derived_public_key", { path: PATH, predecessor: CONTRACT, domain_id: DOMAIN });
const from = evmAddressFromNearKey(key);
const funder = privateKeyToAccount((env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : "0x" + env.PRIVATE_KEY) as `0x${string}`).address;
const to = (process.env.TO ?? funder) as `0x${string}`;
const value = BigInt(process.env.VALUE_WEI ?? "100000000000000");
const payoutId = Number(process.env.PAYOUT_ID ?? Date.now());

const [nonce, block] = await Promise.all([baseClient.getTransactionCount({ address: from, blockTag: "pending" }), baseClient.getBlock()]);
const prio = parseGwei("0.001"); // Base Sepolia priority fees are ~0; 1 mwei-gwei is plenty
const baseFee = block.baseFeePerGas ?? parseGwei("0.001");
const maxFee = baseFee * 3n + prio; // 3x headroom so the signed tx stays valid for a few minutes of base-fee drift
const gasLimit = BigInt(process.env.GAS_LIMIT ?? "21000");
console.log({ from, to, value: value.toString(), nonce, baseFee: baseFee.toString(), maxFee: maxFee.toString(), prio: prio.toString(), payoutId });

// Independent digest: viem's serialization vs the contract's omni-transaction serialization.
const args = { payout_id: payoutId, to, value_wei: value.toString(), nonce, max_fee_per_gas: maxFee.toString(), max_priority_fee_per_gas: prio.toString(), gas_limit: Number(gasLimit) };
const preview = await nearView(CONTRACT, "preview", { to, value_wei: args.value_wei, nonce, max_fee_per_gas: args.max_fee_per_gas, max_priority_fee_per_gas: args.max_priority_fee_per_gas, gas_limit: args.gas_limit });
const viemUnsigned = serializeTransaction({ type: "eip1559", chainId: 84532, nonce, to, value, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, gas: gasLimit });
if (preview.unsigned !== viemUnsigned || preview.digest !== keccak256(viemUnsigned)) throw new Error("contract preview != viem serialization");
console.log("preview matches viem, digest", preview.digest);

const root = await makeAccount(ROOT_ACCOUNT);
const t0 = Date.now();
const call = await callAndWait(root, CONTRACT, "sign_payout", args, 200_000_000_000_000n, 0n);
const signMs = call.doneAt - call.sentAt;
const status = call.outcome.status;
if (status.Failure) throw new Error("sign_payout failed: " + JSON.stringify(status.Failure).slice(0, 400));
const raw = successValue(call.outcome) as string | null;
const gas = gasBurnt(call.outcome);
console.log("sign_payout NEAR tx", call.hash, nearLinks(call.hash), `| ${signMs} ms | ${gas.tgas.toFixed(2)} Tgas burnt`);
console.log("events:", logsOf(call.outcome).filter((l) => l.startsWith("EVENT_JSON")).map((l) => l.slice(0, 160)));
if (!raw) throw new Error("callback returned null (see events above)");

const recovered = await recoverTransactionAddress({ serializedTransaction: raw as `0x${string}` });
const parsed = parseTransaction(raw as `0x${string}`);
console.log("recovered signer:", recovered, recovered.toLowerCase() === from.toLowerCase() ? "== derived address" : "MISMATCH");
if (recovered.toLowerCase() !== from.toLowerCase()) throw new Error("recovered address mismatch");
console.log("raw tx", raw, "| nonce", parsed.nonce ?? 0, "yParity", parsed.yParity);

// Replay: same payout_id must return the stored tx and not call the signer again.
await new Promise((r) => setTimeout(r, 4000)); // let the RPC pool catch up on the access-key nonce
const rep = await callAndWait(root, CONTRACT, "sign_payout", args, 200_000_000_000_000n, 0n);
const sameRaw = successValue(rep.outcome) === raw;
const signerCalled = (rep.outcome.receipts_outcome as any[]).some((r) => r.outcome.executor_id === SIGNER);
console.log("replay tx", rep.hash, "| same raw:", sameRaw, "| signer called again:", signerCalled, `| ${gasBurnt(rep.outcome).tgas.toFixed(2)} Tgas`);

const result: any = { from, to, value: value.toString(), nonce, payoutId, nearTx: call.hash, signMs, gasTgas: gas.tgas, raw, replayTx: rep.hash, replaySameRaw: sameRaw, replaySignerCalled: signerCalled, maxFee: maxFee.toString(), prio: prio.toString(), baseFee: baseFee.toString() };
if (process.env.BROADCAST !== "0") {
  const bal = await baseClient.getBalance({ address: from });
  console.log("derived balance", formatEther(bal), "ETH");
  const t1 = Date.now();
  try {
    const hash = await baseClient.sendRawTransaction({ serializedTransaction: raw as `0x${string}` });
    const rcpt = await baseClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    Object.assign(result, { baseTx: hash, baseStatus: rcpt.status, baseBlock: rcpt.blockNumber.toString(), gasUsed: rcpt.gasUsed.toString(), effGasPrice: rcpt.effectiveGasPrice.toString(), broadcastToMinedMs: Date.now() - t1, totalCallToMinedMs: Date.now() - t0 });
    console.log("BASE SEPOLIA tx", hash, baseLink(hash), rcpt.status, "| broadcast->mined", Date.now() - t1, "ms | total", Date.now() - t0, "ms");
  } catch (e: any) {
    const m = String(e.shortMessage ?? e.message).replace(/https?:\/\/\S+/g, "<rpc>");
    result.broadcastError = m.slice(0, 300);
    console.log("broadcast failed:", result.broadcastError, e.details ? String(e.details).slice(0, 200) : "");
  }
}
writeFileSync(`result-${payoutId}.json`, JSON.stringify(result, null, 1));
