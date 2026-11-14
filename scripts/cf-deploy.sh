#!/usr/bin/env bash
# COORDINATOR ONLY (deploys): builds web with VITE_CONTRACT_ID and deploys the Pages project `title-shot` (static site + functions)
# with the vars the Worker needs. Run scripts/cf-setup.sh once before (KV namespace, project, role secrets).
#
#   CONTRACT_ID=staging.titleshot.testnet scripts/cf-deploy.sh staging [--dry-run] [--branch preview] [--project title-shot]
#
#   staging     COMPILER_MODE=standin and pushes the STANDIN_SIGNER_KEY secret from .env.local (never printed). The stand-in is inert
#               while a NEARAI_API_KEY secret exists on the project: a real key always wins (see web/functions/_lib/standin.ts).
#   --branch main deploys the production environment; any other branch (default preview) the preview environment, and the secret
#               goes to the matching environment. The check at the end fails the script if the deployed state does not match.
#   production  no COMPILER_MODE and no stand-in key: the compile is NEAR AI (NEARAI_API_KEY must already be a project secret).
#
# web/wrangler.toml is edited for the deploy ([vars] CONTRACT_ID, COMPILER_MODE) and restored on exit, so no repo diff is left behind.
# Needs CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (read from .env.local). --dry-run prints every command and changes nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
usage() { sed -n "2,14p" "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
MODE=${1:-}; [ -n "$MODE" ] || usage
shift
DRY=0; BRANCH=preview; PROJECT=title-shot
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --branch) BRANCH=${2:-}; shift 2 ;;
    --project) PROJECT=${2:-}; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
case "$MODE" in staging|production) ;; *) echo "mode must be staging or production" >&2; exit 2 ;; esac
CONTRACT_ID=${CONTRACT_ID:-}
[[ "$CONTRACT_ID" =~ ^[a-z0-9._-]+\.testnet$ ]] || { echo "set CONTRACT_ID to the deployed contract account (for example staging.titleshot.testnet)" >&2; exit 2; }
[[ "$BRANCH" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "bad --branch" >&2; exit 2; }
export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang

envv() { sed -n "s/^$1=//p" .env.local 2>/dev/null | head -1 | tr -d '"'; }
show() { local o="+"; for a in "$@"; do case "$a" in *[!A-Za-z0-9_./:=@,+-]*|"") o+=" '$a'" ;; *) o+=" $a" ;; esac; done; echo "$o"; }
run() { show "$@"; [ "$DRY" = 1 ] || "$@"; }
for v in CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID; do
  if [ -z "${!v:-}" ]; then val=$(envv "$v"); [ -n "$val" ] && export "$v=$val"; fi
  if [ -z "${!v:-}" ] && [ "$DRY" != 1 ]; then echo "$v is not set (and not in .env.local)" >&2; exit 1; fi
done

echo "== $MODE deploy of $PROJECT (branch $BRANCH) for contract $CONTRACT_ID$([ "$DRY" = 1 ] && echo '  [DRY RUN: nothing is executed]')"
# Tick state in KV is scoped by contract id, but the preview environment (and its secrets) is still shared with staging.
[ "$MODE" = production ] && [ "$BRANCH" != main ] && echo "WARNING: production on branch '$BRANCH' shares the preview environment with staging; use --branch main for a separate one" >&2

# 1. vars: patch web/wrangler.toml for this deploy, restore it afterwards
TOML=web/wrangler.toml
COMPILER=""; [ "$MODE" = staging ] && COMPILER=standin
echo "+ vars for this deploy: CONTRACT_ID=\"$CONTRACT_ID\" COMPILER_MODE=\"$COMPILER\" (web/wrangler.toml [vars], restored on exit)"
if [ "$DRY" != 1 ]; then
  cp "$TOML" "$TOML.deploy-bak"
  trap 'mv -f "$TOML.deploy-bak" "$TOML"' EXIT
  sed -i '' "s#^CONTRACT_ID = \".*\"#CONTRACT_ID = \"$CONTRACT_ID\"#" "$TOML"
  sed -i '' '/^COMPILER_MODE = /d' "$TOML"
  [ -n "$COMPILER" ] && printf 'COMPILER_MODE = "%s"\n' "$COMPILER" >> "$TOML"
  grep -q "^CONTRACT_ID = \"$CONTRACT_ID\"" "$TOML" || { echo "could not set CONTRACT_ID in $TOML" >&2; exit 1; }
fi

# 2. secrets (value piped, never echoed)
W=(pnpm --dir web exec wrangler)
PENV=preview; [ "$BRANCH" = main ] && PENV=production   # Pages keeps secrets per environment: a non-main branch deploys to "preview"
if [ "$MODE" = staging ]; then
  if [ -z "$(envv STANDIN_SIGNER_KEY)" ]; then echo "STANDIN_SIGNER_KEY is not in .env.local: run node scripts/gen-standin-key.mjs first" >&2; exit 1; fi
  echo "+ printf <STANDIN_SIGNER_KEY from .env.local> | ${W[*]} pages secret put STANDIN_SIGNER_KEY --project-name $PROJECT --env $PENV"
  if [ "$DRY" != 1 ]; then printf '%s' "$(envv STANDIN_SIGNER_KEY)" | "${W[@]}" pages secret put STANDIN_SIGNER_KEY --project-name "$PROJECT" --env "$PENV" >/dev/null && echo "secret STANDIN_SIGNER_KEY set ($PENV)"; fi
  [ -n "$(envv NEARAI_API_KEY)" ] && echo "note: .env.local has NEARAI_API_KEY; if cf-setup.sh pushed it, the stand-in is inactive (real key wins)"
fi

# 3. build the site against the contract, then deploy dist + functions
echo "+ cd web && VITE_CONTRACT_ID=$CONTRACT_ID pnpm build"
[ "$DRY" = 1 ] || (cd web && VITE_CONTRACT_ID="$CONTRACT_ID" pnpm build)
run "${W[@]}" pages deploy dist --project-name "$PROJECT" --branch "$BRANCH" --commit-dirty=true

# 4. check the deployed API reports the right compiler and contract
URL="https://$BRANCH.$PROJECT.pages.dev"
WANT=${COMPILER:-nearai}
FORGE=relayer; [ "$MODE" = production ] && FORGE=outlayer
EXPECT="$WANT $CONTRACT_ID $FORGE"
echo "+ curl -s $URL/api/state   (expect compiler=\"$WANT\", contract=\"$CONTRACT_ID\", forgeMode=\"$FORGE\")"
if [ "$DRY" != 1 ]; then
  OK=0
  for i in 1 2 3 4 5 6; do
    GOT=$(curl -s -m 20 "$URL/api/state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);console.log((j.compiler||j.code||"?")+" "+(j.contract||"")+" "+(j.forgeMode||""))}catch{console.log("unreadable")}})')
    echo "  try $i: $GOT"
    [ "$GOT" = "$EXPECT" ] && { OK=1; break; }
    sleep 5
  done
  [ "$OK" = 1 ] || { echo "the deployed /api/state does not report \"$EXPECT\" (compiler contract forgeMode)" >&2; exit 1; }
fi
echo "+ node scripts/smoke.mjs $URL"
echo "== done: $URL"
