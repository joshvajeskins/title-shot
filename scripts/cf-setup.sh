#!/usr/bin/env bash
# COORDINATOR ONLY (deploys): creates the KV namespace, patches web/wrangler.toml, creates the Pages project and pushes
# secrets from ~/.near-credentials and .env.local without printing them. Needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
# in the environment (they are in .env.local: `set -a; . ./.env.local; set +a`). Not run by the worker lane.
set -euo pipefail
cd "$(dirname "$0")/../web"
export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang
W="pnpm exec wrangler"
PROJECT=title-shot

# 1. KV namespace (idempotent: reuse the id if the title already exists)
ID=$($W kv namespace list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const n=a.find(x=>x.title==="title-shot-TS_KV"||x.title==="TS_KV");console.log(n?n.id:"")}catch{console.log("")}})')
if [ -z "$ID" ]; then
  ID=$($W kv namespace create TS_KV 2>&1 | sed -n 's/.*"id": "\([0-9a-f]\{32\}\)".*/\1/p' | head -1)
fi
[ -n "$ID" ] || { echo "could not create/find the KV namespace" >&2; exit 1; }
sed -i '' "s/^id = \".*\"/id = \"$ID\"/" wrangler.toml
echo "KV namespace id set in wrangler.toml"

# 2. Pages project
$W pages project create "$PROJECT" --production-branch main >/dev/null 2>&1 || true

# 3. secrets (values piped from files, never echoed)
put() { printf '%s' "$2" | $W pages secret put "$1" --project-name "$PROJECT" >/dev/null && echo "secret $1 set"; }
cred() { node -e 'const j=require(process.env.HOME+"/.near-credentials/testnet/"+process.argv[1]+".json");process.stdout.write(j.private_key)' "$1"; }
envv() { sed -n "s/^$1=//p" ../.env.local | head -1 | tr -d '"'; }
put SPONSOR_KEY "$(cred play.titleshot.testnet)"
put VANCE_KEY "$(cred vance.titleshot.testnet)"
put RELAYER_KEY "$(cred relay.titleshot.testnet)"
[ -n "$(envv NEARAI_API_KEY)" ] && put NEARAI_API_KEY "$(envv NEARAI_API_KEY)" || echo "NEARAI_API_KEY missing: previews and portraits stay offline"
put ELEVENLABS_API_KEY "$(envv ELEVENLABS_API_KEY)"
# The tick token is shared with the bell Worker, so it must survive this run: reuse $TICK_SECRET or the one already in
# .env.local (gitignored); only when neither exists generate one and append it to .env.local. It is never printed.
TICK=${TICK_SECRET:-$(envv TICK_SECRET)}
if [ -z "$TICK" ]; then
  TICK=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')
  [ -n "$(tail -c1 ../.env.local 2>/dev/null)" ] && echo >> ../.env.local
  printf 'TICK_SECRET=%s\n' "$TICK" >> ../.env.local
  chmod 600 ../.env.local
  echo "TICK_SECRET generated and saved to .env.local (value not shown)"
fi
put TICK_SECRET "$TICK"
echo "bell Worker: scripts/cf-bell.sh reads TICK_SECRET from .env.local and deploys title-shot-bell with the same token"
echo "next: set CONTRACT_ID in web/wrangler.toml [vars], pnpm exec vite build, $W pages deploy dist --project-name $PROJECT"
