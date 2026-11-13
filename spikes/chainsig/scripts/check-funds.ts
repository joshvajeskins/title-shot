import { privateKeyToAccount } from "viem/accounts";
import { formatEther } from "viem";
import { env, baseClient, nearBalance, nearView, SIGNER, CONTRACT, PATH, DOMAIN, evmAddressFromNearKey, ROOT_ACCOUNT } from "./lib.ts";

const pk = (env.PRIVATE_KEY.startsWith("0x") ? env.PRIVATE_KEY : "0x" + env.PRIVATE_KEY) as `0x${string}`;
const funder = privateKeyToAccount(pk);
console.log("funder address (testnet wallet):", funder.address);
console.log("funder Base Sepolia balance:", formatEther(await baseClient.getBalance({ address: funder.address })), "ETH");
console.log("chainId:", await baseClient.getChainId());
const key = await nearView(SIGNER, "derived_public_key", { path: PATH, predecessor: CONTRACT, domain_id: DOMAIN });
const addr = evmAddressFromNearKey(key);
console.log("derived key:", key);
console.log("derived EVM address:", addr);
console.log("derived Base Sepolia balance:", formatEther(await baseClient.getBalance({ address: addr })), "ETH");
console.log(`${ROOT_ACCOUNT} NEAR:`, Number(await nearBalance(ROOT_ACCOUNT)) / 1e24);
console.log("signer version:", await nearView(SIGNER, "version", {}));
