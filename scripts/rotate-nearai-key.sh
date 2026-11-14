#!/usr/bin/env bash
# Rotate the NEAR AI key of Title Shot and set its spend limits (docs/BUDGET.md "Rotate script"). The key is never printed:
# only its fingerprint (first 16 hex of sha256(key)), which is also what the worker ledger is keyed by.
#
#   CONTRACT_ID=titleshot.testnet scripts/rotate-nearai-key.sh --budget 9 --public-daily 1 --public-total 8.5 [--dry-run]
#                                  [--env production|preview] [--network <near-cli network>]
#
#   1. vault: ~/.claude/vault/inject.sh get TITLE_SHOT_NEARAI_API_KEY into a private temp dir; NEARAI_API_KEY in .env.local replaced
#   2. Pages project title-shot (--env, default production): secret NEARAI_API_KEY (stdin) + NEARAI_BUDGET_USD,
#      NEARAI_PUBLIC_DAILY_USD, NEARAI_PUBLIC_TOTAL_USD (pushed as secrets: wrangler.toml [vars] must not carry them)
#   3. OutLayer project secret, opened only through CONTRACT_ID (scripts/outlayer-secret.mjs, the forge/README.md command)
#   4. contract CONTRACT_ID (owner titleshot.testnet, 1 yocto): reset_compile_counter, then
#      set_compile_caps(daily = floor(public_daily / 0.00064), total = floor(public_total / 0.00064))
#   5. smoke: GET /v1/models with the new key must answer 200
#   --dry-run prints every step and runs none of them (no vault read, no file written, no network).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }
BUDGET=""; PDAILY=""; PTOTAL=""; DRY=0; PENV=production; NET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --budget) BUDGET=${2:-}; shift 2 ;;
    --public-daily) PDAILY=${2:-}; shift 2 ;;
    --public-total) PTOTAL=${2:-}; shift 2 ;;
    --env) PENV=${2:-}; shift 2 ;;
    --network) NET=${2:-}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
USD_RE='^[0-9]+(\.[0-9]{1,5})?$'
for pair in "budget:$BUDGET" "public-daily:$PDAILY" "public-total:$PTOTAL"; do
  [[ "${pair#*:}" =~ $USD_RE ]] || { echo "--${pair%%:*} <USD> is required: a plain number with at most 5 decimals (for example 8.5)" >&2; exit 2; }
done
case "$PENV" in production|preview) ;; *) echo "--env must be production or preview" >&2; exit 2 ;; esac
CONTRACT_ID=${CONTRACT_ID:-}
[[ "$CONTRACT_ID" =~ ^[a-z0-9._-]+\.testnet$ ]] || { echo "set CONTRACT_ID to the production game contract (for example titleshot.testnet)" >&2; exit 2; }
[ -z "$NET" ] || [[ "$NET" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "bad --network" >&2; exit 2; }

# USD -> integer units of 0.00001, so the caps are exact (0.00064 = 64 units)
units() { local i=${1%%.*} f=""; [[ "$1" == *.* ]] && f=${1#*.}; f=$(printf '%-5s' "$f" | tr ' ' 0); echo $((10#$i * 100000 + 10#$f)); }
(( $(units "$PTOTAL") <= $(units "$BUDGET") )) || { echo "--public-total cannot exceed --budget" >&2; exit 2; }
CAP_DAILY=$(( $(units "$PDAILY") / 64 ))
CAP_TOTAL=$(( $(units "$PTOTAL") / 64 ))

export PATH=/usr/bin:$PATH AR=/usr/bin/ar AS=/usr/bin/as CC=/usr/bin/clang
NEAR=${NEAR_BIN:-$HOME/.cargo/bin/near}
VAULT=${VAULT_INJECT:-$HOME/.claude/vault/inject.sh}
W=(${WRANGLER_CMD:-pnpm --dir web exec wrangler})
OWNER=titleshot.testnet
PROJECT=title-shot
if [ -z "$NET" ]; then
  CFG="$HOME/Library/Application Support/near-cli/config.toml"; [ -f "$CFG" ] || CFG="$HOME/.config/near-cli/config.toml"
  NET=testnet; grep -q '^\[network_connection.testnet-drpc\]' "$CFG" 2>/dev/null && NET=testnet-drpc
fi
show() { local o="+"; for a in "$@"; do case "$a" in *[!A-Za-z0-9_./:=@,+-]*|"") o+=" '$a'" ;; *) o+=" $a" ;; esac; done; echo "$o"; }
run() { show "$@"; [ "$DRY" = 1 ] || "$@"; }

echo "== rotate the NEAR AI key: budget \$$BUDGET, public \$$PDAILY/day and \$$PTOTAL total; contract caps daily $CAP_DAILY, total $CAP_TOTAL ($PENV, $CONTRACT_ID)$([ "$DRY" = 1 ] && echo '  [DRY RUN: nothing is executed]')"

# 1. the key, from the vault into a private temp dir (removed on exit), into .env.local
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; return 0; }
trap cleanup EXIT
echo "+ $VAULT get TITLE_SHOT_NEARAI_API_KEY --dir <private temp dir>"
echo "+ replace NEARAI_API_KEY in .env.local (value not shown)"
FP="<fingerprint after the vault read>"
if [ "$DRY" != 1 ]; then
  TMP=$(mktemp -d); chmod 700 "$TMP"
  "$VAULT" get TITLE_SHOT_NEARAI_API_KEY --dir "$TMP" >/dev/null
  KEYFILE="$TMP/key"
  sed -n 's/^TITLE_SHOT_NEARAI_API_KEY=//p' "$TMP/.env.local" | head -1 | sed 's/^"\(.*\)"$/\1/' | tr -d '\r\n' > "$KEYFILE"
  chmod 600 "$KEYFILE"
  [ -s "$KEYFILE" ] || { echo "TITLE_SHOT_NEARAI_API_KEY is not in the vault" >&2; exit 1; }
  FP=$(shasum -a 256 < "$KEYFILE" | cut -c1-16)
  KEYFILE="$KEYFILE" ENVFILE="$ROOT/.env.local" node "$ROOT/scripts/set-env-key.mjs"
fi
echo "key fingerprint: $FP"

# 2. Pages secrets (values piped on stdin, never in argv)
put() { echo "+ printf $2 | ${W[*]} pages secret put $1 --project-name $PROJECT --env $PENV"; [ "$DRY" = 1 ] || { cat - | "${W[@]}" pages secret put "$1" --project-name "$PROJECT" --env "$PENV" >/dev/null; echo "  secret $1 set"; }; }
if [ "$DRY" = 1 ]; then : | put NEARAI_API_KEY '<key>'; else put NEARAI_API_KEY '<key>' < "$KEYFILE"; fi
printf '%s' "$BUDGET" | put NEARAI_BUDGET_USD "$BUDGET"
printf '%s' "$PDAILY" | put NEARAI_PUBLIC_DAILY_USD "$PDAILY"
printf '%s' "$PTOTAL" | put NEARAI_PUBLIC_TOTAL_USD "$PTOTAL"

# 3. OutLayer secret (the helper reads .env.local, prints only the fingerprint and scrubs the CLI output)
run node "$ROOT/scripts/outlayer-secret.mjs" "$CONTRACT_ID"

# 4. contract counters and caps (owner, 1 yocto each)
owner_call() { run "$NEAR" contract call-function as-transaction "$CONTRACT_ID" "$1" json-args "$2" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER" network-config "$NET" sign-with-legacy-keychain send; }
owner_call reset_compile_counter '{}'
owner_call set_compile_caps "{\"daily\":$CAP_DAILY,\"total\":$CAP_TOTAL}"
run "$NEAR" contract call-function as-read-only "$CONTRACT_ID" get_compile_caps json-args '{}' network-config "$NET" now

# 5. smoke: the new key is accepted (the auth header goes through a private file, not argv)
echo "+ curl -s -H @<auth header file> https://cloud-api.near.ai/v1/models   (expect 200)"
if [ "$DRY" != 1 ]; then
  printf 'authorization: Bearer %s\n' "$(cat "$KEYFILE")" > "$TMP/hdr"; chmod 600 "$TMP/hdr"
  CODE=$(curl -s -m 30 -o /dev/null -w '%{http_code}' -H @"$TMP/hdr" https://cloud-api.near.ai/v1/models)
  [ "$CODE" = 200 ] || { echo "smoke call answered HTTP $CODE (key fingerprint $FP)" >&2; exit 1; }
  echo "  smoke: 200"
fi
echo "== done: NEAR AI key $FP, budget \$$BUDGET, public \$$PDAILY/day \$$PTOTAL total, contract caps $CAP_DAILY/day $CAP_TOTAL total"
