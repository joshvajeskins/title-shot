#!/usr/bin/env python3
"""Measure a forge round trip from its transaction hash(es): request->callback latency, OutLayer
charge, result size and callback verdict. Read-only RPC calls.

  python3 -I scripts/measure.py <tx_hash> [<tx_hash> ...]
  RPC_URL=https://near-testnet.drpc.org python3 -I scripts/measure.py <tx_hash>
Signer defaults to titleshot.testnet (override with SIGNER).
"""
import json, os, re, sys, urllib.request

RPCS = [os.environ["RPC_URL"]] if os.environ.get("RPC_URL") else [
    "https://near-testnet.drpc.org", "https://test.rpc.fastnear.com", "https://rpc.testnet.fastnear.com"]
SIGNER = os.environ.get("SIGNER", "titleshot.testnet")


def rpc(method, params):
    last = None
    for url in RPCS:
        try:
            req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                         {"content-type": "application/json", "user-agent": "titleshot-spike"})
            out = json.load(urllib.request.urlopen(req, timeout=60))
            if "result" in out:
                return out["result"]
            last = out
        except Exception as e:  # noqa
            last = e
    raise SystemExit(f"rpc failed: {last}")


def block_ts_ms(block_hash):
    return int(rpc("block", {"block_id": block_hash})["header"]["timestamp"]) // 1_000_000


def measure(tx):
    r = rpc("EXPERIMENTAL_tx_status", {"tx_hash": tx, "sender_account_id": SIGNER, "wait_until": "FINAL"})
    t_tx = block_ts_ms(r["transaction_outcome"]["block_hash"])
    t_cb = t_req = None
    charge = size = verdict = fields = None
    for o in r["receipts_outcome"]:
        logs = o["outcome"]["logs"]
        text = "\n".join(logs)
        if "execution_requested" in text and t_req is None:
            t_req = block_ts_ms(o["block_hash"])
        m = re.search(r'payment_charged\\?":\\?"(\d+)', text)
        if m:
            charge = int(m.group(1)) / 1e24
        m = re.search(r"forge result: (\d+) bytes, fields: (\S+)", text)
        if m:
            size, fields = int(m.group(1)), m.group(2)
            t_cb = block_ts_ms(o["block_hash"])
        ev = re.search(r'"event":"(forged|forge_refused)"', text)
        if ev:
            why = re.search(r'"reason":"((?:[^"\\]|\\.)*)"', text)
            verdict = f"{ev.group(1)} ({why.group(1)[:70] if why else ''})"
            t_cb = t_cb or block_ts_ms(o["block_hash"])
    failed = "Execution promise failed" in "".join("\n".join(o["outcome"]["logs"]) for o in r["receipts_outcome"])
    print(json.dumps({
        "tx": tx, "request_to_callback_s": round((t_cb - t_tx) / 1000, 1) if t_cb else None,
        "outlayer_charge_near": charge, "result_bytes": size, "fields": fields,
        "verdict": verdict, "yield_timeout": failed}, indent=None))


if __name__ == "__main__":
    for t in sys.argv[1:]:
        measure(t)
