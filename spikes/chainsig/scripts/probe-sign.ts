// Direct call of the live signer from titleshot.testnet to learn the exact response JSON shape + latency.
import { randomBytes } from "node:crypto";
import { makeAccount, logsOf, gasBurnt, successValue, callAndWait } from "./near.ts";
import { SIGNER, ROOT_ACCOUNT, nearLinks } from "./lib.ts";

const acct = await makeAccount(ROOT_ACCOUNT);
const payload = randomBytes(32).toString("hex");
const { outcome, hash, sentAt, doneAt } = await callAndWait(
  acct, SIGNER, "sign",
  { request: { payload_v2: { Ecdsa: payload }, path: "probe", domain_id: 0 } },
  300_000_000_000_000n, 1n,
);
console.log("latency ms", doneAt - sentAt, "tx", hash, nearLinks(hash));
console.log("gas", gasBurnt(outcome).tgas, "Tgas");
console.log("value", JSON.stringify(successValue(outcome)));
console.log("logs", logsOf(outcome));
