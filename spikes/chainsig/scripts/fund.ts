// Send 0.003 ETH from the PRIVATE_KEY testnet wallet to the contract's derived address, once that wallet has Base Sepolia ETH.
import { createWalletClient, http, fallback, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { env, baseClient, BASE_RPCS, nearView, SIGNER, CONTRACT, PATH, DOMAIN, evmAddressFromNearKey, baseLink } from "./lib.ts";
const acct = privateKeyToAccount((env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : "0x" + env.PRIVATE_KEY) as `0x${string}`);
const to = evmAddressFromNearKey(await nearView(SIGNER, "derived_public_key", { path: PATH, predecessor: CONTRACT, domain_id: DOMAIN }));
const bal = await baseClient.getBalance({ address: acct.address });
console.log("funder", acct.address, formatEther(bal), "ETH ->", to);
if (bal < parseEther("0.0031")) { console.log("funder underfunded: faucet needed (see RESULT.md)"); process.exit(2); }
const w = createWalletClient({ account: acct, chain: baseSepolia, transport: fallback(BASE_RPCS.map((u) => http(u))) });
const hash = await w.sendTransaction({ to, value: parseEther("0.003") });
await baseClient.waitForTransactionReceipt({ hash });
console.log("funded", baseLink(hash));
