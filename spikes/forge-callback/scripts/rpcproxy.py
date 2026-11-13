#!/usr/bin/env python3
"""Local NEAR testnet RPC proxy with provider fallback. Used only so the outlayer CLI survives 429s.
Usage: python3 -I rpcproxy.py [port]. Logs method + status (never bodies of txs) to stderr."""
import json, sys, time, urllib.request, urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAMS = [
    "https://near-testnet.drpc.org",
    "https://test.rpc.fastnear.com",
    "https://rpc.testnet.fastnear.com",
    "https://testnet-rpc.intea.rs",
]


def call(url, body):
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "user-agent": "titleshot-spike"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # noqa
        return 599, str(e).encode()


class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = self.rfile.read(n)
        try:
            method = json.loads(body).get("method")
        except Exception:
            method = "?"
        last = (599, b"{}")
        for attempt in range(3):
            for u in UPSTREAMS:
                st, out = call(u, body)
                ok = st == 200 and b'rate limit' not in out and b'slowed down' not in out
                sys.stderr.write(f"{method} {u.split('//')[1]} -> {st} {'ok' if ok else out[:160]}\n")
                last = (st, out)
                if ok:
                    break
            else:
                time.sleep(1.5)
                continue
            break
        try:
            j = json.loads(last[1])
            if "note" in j:
                del j["note"]
                last = (last[0], json.dumps(j).encode())
        except Exception:
            pass
        self.send_response(last[0] if last[0] != 599 else 502)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(last[1])

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8911
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
