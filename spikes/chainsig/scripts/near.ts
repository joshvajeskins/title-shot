import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, KeyPair, providers, InMemorySigner, Connection, transactions, utils } from "near-api-js";
import { NEAR_RPCS } from "./lib.ts";

export function loadKey(accountId: string): KeyPair {
  const dir = join(homedir(), ".near-credentials/testnet");
  const f = join(dir, `${accountId}.json`);
  if (!existsSync(f)) throw new Error(`no credentials for ${accountId}`);
  const j = JSON.parse(readFileSync(f, "utf8"));
  return KeyPair.fromString(j.private_key);
}

export async function makeAccount(accountId: string, rpcIndex = 0): Promise<Account> {
  const signer = await InMemorySigner.fromKeyPair("testnet", accountId, loadKey(accountId));
  const provider = new providers.JsonRpcProvider({ url: NEAR_RPCS[rpcIndex] });
  const conn = Connection.fromConfig({ networkId: "testnet", provider, signer, jsvmAccountId: "" });
  return new Account(conn, accountId);
}

export function logsOf(outcome: any): string[] {
  const out: string[] = [];
  for (const o of outcome.receipts_outcome ?? []) out.push(...(o.outcome?.logs ?? []));
  return out;
}
export function gasBurnt(outcome: any): { total: bigint; tgas: number } {
  let t = BigInt(outcome.transaction_outcome.outcome.gas_burnt);
  for (const o of outcome.receipts_outcome ?? []) t += BigInt(o.outcome.gas_burnt);
  return { total: t, tgas: Number(t) / 1e12 };
}
export function successValue(outcome: any): any {
  const v = outcome.status?.SuccessValue;
  if (v === undefined) return undefined;
  return v === "" ? null : JSON.parse(Buffer.from(v, "base64").toString());
}

import { actionCreators } from "@near-js/transactions";
import { nearRpc } from "./lib.ts";

let lastNonce = 0n;
/** Sign with an explicit nonce read from RPC (near-api-js' cached-nonce path stalled on a second call in one process). */
async function signNow(acct: Account, receiver: string, actions: any[]): Promise<[Uint8Array, any]> {
  const pk = (await acct.connection.signer.getPublicKey(acct.accountId, "testnet")).toString();
  const [ak, blk] = await Promise.all([
    nearRpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: acct.accountId, public_key: pk }),
    nearRpc("block", { finality: "final" }),
  ]);
  const nonce = (BigInt(ak.nonce) > lastNonce ? BigInt(ak.nonce) : lastNonce) + 1n;
  lastNonce = nonce;
  const tx = transactions.createTransaction(acct.accountId, utils.PublicKey.from(pk), receiver, Number(nonce), actions, utils.serialize.base_decode(blk.header.hash));
  return transactions.signTransaction(tx, acct.connection.signer, acct.accountId, "testnet");
}

/** drpc's free plan kills broadcast_tx_commit after a few seconds, and sign() takes longer: send async and poll. */
export async function callAndWait(
  acct: Account, contractId: string, methodName: string, args: object, gas: bigint, deposit: bigint,
  timeoutMs = 240_000,
): Promise<{ outcome: any; hash: string; sentAt: number; doneAt: number }> {
  const action = actionCreators.functionCall(methodName, Buffer.from(JSON.stringify(args)), gas, deposit);
  let hash: Uint8Array = new Uint8Array();
  let sentAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    const [h, signed] = await signNow(acct, contractId, [action]);
    hash = h;
    sentAt = Date.now();
    try { await nearRpc("send_tx", { signed_tx_base64: Buffer.from(signed.encode()).toString("base64"), wait_until: "NONE" }); break; }
    catch (e: any) { if (attempt >= 6 || !String(e.message).includes("InvalidNonce")) throw e; await new Promise((r) => setTimeout(r, 1500)); }
  }
  const hashStr: string = (await import("bs58")).default.encode(Buffer.from(hash));
  while (Date.now() - sentAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const r = await nearRpc("tx", { tx_hash: hashStr, sender_account_id: acct.accountId, wait_until: "EXECUTED" });
      if (r?.final_execution_status === "FINAL" || r?.final_execution_status === "EXECUTED") {
        return { outcome: r, hash: hashStr, sentAt, doneAt: Date.now() };
      }
    } catch (e: any) { if (process.env.DEBUG) console.error("poll", String(e.message).slice(0, 120)); }
  }
  throw new Error(`timeout waiting for ${hashStr}`);
}
