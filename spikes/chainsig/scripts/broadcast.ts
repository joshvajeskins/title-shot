// Broadcast an already-signed payout stored in the contract (get_raw_tx). Usage: PAYOUT_ID=<id> npx tsx broadcast.ts
import { formatEther, parseTransaction } from "viem";
import { baseClient, nearView, CONTRACT, SIGNER, PATH, DOMAIN, evmAddressFromNearKey, baseLink } from "./lib.ts";
const id = Number(process.env.PAYOUT_ID);
const raw = (await nearView(CONTRACT, "get_raw_tx", { payout_id: id })) as `0x${string}` | null;
if (!raw) throw new Error(`payout ${id} not signed`);
const from = evmAddressFromNearKey(await nearView(SIGNER, "derived_public_key", { path: PATH, predecessor: CONTRACT, domain_id: DOMAIN }));
const t = parseTransaction(raw);
console.log("balance", formatEther(await baseClient.getBalance({ address: from })), "| nonce on chain", await baseClient.getTransactionCount({ address: from }), "| tx nonce", t.nonce ?? 0, "value", t.value);
const t1 = Date.now();
const hash = await baseClient.sendRawTransaction({ serializedTransaction: raw });
const rcpt = await baseClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
console.log("BASE SEPOLIA", hash, baseLink(hash), rcpt.status, "block", rcpt.blockNumber, "gasUsed", rcpt.gasUsed, "effGasPrice", rcpt.effectiveGasPrice, "| broadcast->mined", Date.now() - t1, "ms");
