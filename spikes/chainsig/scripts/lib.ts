import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, http, fallback, keccak256, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import bs58 from "bs58";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "../../..");

export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
export const env = loadEnv();

export const NEAR_RPCS = [
  "https://near-testnet.drpc.org",
  "https://rpc.testnet.fastnear.com",
  "https://test.rpc.fastnear.com",
  "https://testnet-rpc.intea.rs",
];
export const SIGNER = "v1.signer-prod.testnet";
export const CONTRACT = "cs.titleshot.testnet";
export const ROOT_ACCOUNT = "titleshot.testnet";
export const PATH = "belt-1";
export const DOMAIN = 0;

// BASE_SEPOLIA_RPC_URL in .env.local (Alchemy) currently answers 403 "App is inactive" (verified 2026-11-14),
// so public RPCs come first and it is last resort. Never log URLs: the Alchemy one embeds a key.
export const BASE_RPCS = [
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
  "https://base-sepolia.gateway.tenderly.co",
  ...(env.BASE_SEPOLIA_RPC_URL ? [env.BASE_SEPOLIA_RPC_URL] : []),
];
export const baseClient = createPublicClient({
  chain: baseSepolia,
  transport: fallback(BASE_RPCS.map((u) => http(u, { retryCount: 1 })), { rank: false }),
});

export async function nearRpc(method: string, params: unknown): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    for (const url of NEAR_RPCS) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "x", method, params }),
          signal: AbortSignal.timeout(12_000), // a hung socket must rotate to the next RPC, not stall the whole script
        });
        if (r.status === 429 || r.status === 403) { last = `${url} ${r.status}`; continue; }
        const j: any = await r.json();
        if (j.error) { last = JSON.stringify(j.error).slice(0, 300); const cn = j.error.cause?.name; if (cn === "UNKNOWN_TRANSACTION" || cn === "INVALID_TRANSACTION") throw Object.assign(new Error(JSON.stringify(j.error).slice(0, 300)), { rpcCause: cn }); continue; }
        return j.result;
      } catch (e: any) { if (e?.rpcCause) throw e; last = e; }
    }
    await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
  }
  throw new Error(`nearRpc ${method} failed: ${String(last)}`);
}

export async function nearView(account: string, method: string, args: object): Promise<any> {
  const r = await nearRpc("query", {
    request_type: "call_function", finality: "final", account_id: account, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString());
}

export async function nearBalance(account: string): Promise<bigint> {
  const r = await nearRpc("query", { request_type: "view_account", finality: "final", account_id: account });
  return BigInt(r.amount);
}

/** "secp256k1:<base58 of 64 bytes X||Y>" -> EVM address (0x, lowercase) */
export function evmAddressFromNearKey(nearKey: string): `0x${string}` {
  const raw = bs58.decode(nearKey.replace("secp256k1:", ""));
  if (raw.length !== 64) throw new Error(`unexpected key length ${raw.length}`);
  const h = keccak256(("0x" + Buffer.from(raw).toString("hex")) as Hex);
  return ("0x" + h.slice(26)) as `0x${string}`;
}

export const nearLinks = (tx: string) => `https://testnet.nearblocks.io/txns/${tx}`;
export const baseLink = (tx: string) => `https://sepolia.basescan.org/tx/${tx}`;
export { homedir };
