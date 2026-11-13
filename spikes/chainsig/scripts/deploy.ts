// Create cs.titleshot.testnet (if missing), deploy the wasm, init, set derived address. Idempotent.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { actionCreators } from "@near-js/transactions";
import { makeAccount, callAndWait, successValue } from "./near.ts";
import { nearRpc, nearBalance, nearView, CONTRACT, ROOT_ACCOUNT, SIGNER, PATH, DOMAIN, evmAddressFromNearKey, nearLinks } from "./lib.ts";

const WASM = join(import.meta.dirname, "../contract/target/near/chainsig_spike.wasm");
const wasm = readFileSync(WASM);
const needNear = (wasm.length * 1e19) / 1e24 + 0.12; // 1e19 yocto/byte storage + headroom
console.log(`wasm ${wasm.length} bytes -> fund ${needNear.toFixed(3)} NEAR`);
const root = await makeAccount(ROOT_ACCOUNT);
const bal = Number(await nearBalance(ROOT_ACCOUNT)) / 1e24;
console.log(`root balance ${bal} NEAR`);

const credDir = join(homedir(), ".near-credentials/testnet");
const credFile = join(credDir, `${CONTRACT}.json`);
let exists = true;
try { await nearRpc("query", { request_type: "view_account", finality: "final", account_id: CONTRACT }); } catch { exists = false; }
if (!exists) {
  if (bal < needNear + 0.3) throw new Error(`root has ${bal} NEAR, need ~${needNear + 0.3}`);
  const kp = KeyPair.fromRandom("ed25519");
  mkdirSync(credDir, { recursive: true });
  writeFileSync(credFile, JSON.stringify({ account_id: CONTRACT, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  const dep = BigInt(Math.ceil(needNear * 1e6)) * 10n ** 18n;
  const acts = [actionCreators.createAccount(), actionCreators.transfer(dep), actionCreators.addKey(kp.getPublicKey(), actionCreators.fullAccessKey())];
  const [h, signed] = await root.signTransaction(CONTRACT, acts);
  await nearRpc("send_tx", { signed_tx_base64: Buffer.from(signed.encode()).toString("base64"), wait_until: "FINAL" });
  console.log("created", CONTRACT);
}
const cs = await makeAccount(CONTRACT);
const code = await nearRpc("query", { request_type: "view_account", finality: "final", account_id: CONTRACT });
if (code.code_hash === "11111111111111111111111111111111") {
  const init = actionCreators.functionCall("new", Buffer.from(JSON.stringify({ owner: ROOT_ACCOUNT, signer: SIGNER, path: PATH, domain_id: DOMAIN, chain_id: 84532 })), 30_000_000_000_000n, 0n);
  const [h, signed] = await cs.signTransaction(CONTRACT, [actionCreators.deployContract(wasm), init]);
  await nearRpc("send_tx", { signed_tx_base64: Buffer.from(signed.encode()).toString("base64"), wait_until: "FINAL" });
  console.log("deployed + init");
}
const key = await nearView(SIGNER, "derived_public_key", { path: PATH, predecessor: CONTRACT, domain_id: DOMAIN });
const addr = evmAddressFromNearKey(key);
if ((await nearView(CONTRACT, "get_address", {})) !== addr) {
  const r = await callAndWait(root, CONTRACT, "set_address", { address: addr }, 30_000_000_000_000n, 0n);
  console.log("set_address", addr, nearLinks(r.hash));
}
console.log("contract address on Base Sepolia:", addr, "| contract NEAR:", Number(await nearBalance(CONTRACT)) / 1e24);
