#!/usr/bin/env bash
# House challengers (docs/LIVENESS.md): creates house-a / house-b.titleshot.testnet from titleshot.testnet, deposits their game
# balance in the contract, then gives each a function-call key limited to `challenge` on the contract for the Worker.
# Dry run by default (prints the plan); --go executes. Idempotent: an existing account, deposit or working key is kept.
#   scripts/setup-house.sh [--go] [--network testnet-drpc] [--contract ring.titleshot.testnet]
# Full-access keys stay in ~/.near-credentials (near-cli legacy keychain). The function-call private keys are written ONLY to
# the gitignored .env.local as HOUSE_A_KEY / HOUSE_B_KEY (never printed); push them with `wrangler pages secret put`.
# Prints account ids and transaction hashes only.
set -euo pipefail
export PATH=/usr/bin:$PATH AR=/usr/bin/ar AS=/usr/bin/as CC=/usr/bin/clang

ROOT=$(cd "$(dirname "$0")/.." && pwd)
NEAR=${NEAR_BIN:-$HOME/.cargo/bin/near}
OWNER=titleshot.testnet
CONTRACT=ring.titleshot.testnet
NET=testnet-drpc
FUND=0.8        # NEAR per house account (from titleshot.testnet)
DEPOSIT=0.5     # NEAR of game balance per house account (the first 0.005 is the contract's account storage)
ALLOWANCE=0.25  # NEAR of gas allowance on the function-call key
GO=0
while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;;
    --network) NET=$2; shift ;;
    --contract) CONTRACT=$2; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ -x "$NEAR" ] || { echo "near-cli-rs not found at $NEAR" >&2; exit 1; }
ENVF="$ROOT/.env.local"
git -C "$ROOT" check-ignore -q "$ENVF" || { echo ".env.local is not gitignored: refusing to write keys there" >&2; exit 1; }
SIGN=(network-config "$NET" sign-with-legacy-keychain send)
LOG=$(mktemp -t house-setup); chmod 600 "$LOG"; trap 'rm -f "$LOG"' EXIT
strip() { sed 's/\x1b\[[0-9;]*m//g'; }
q() { { "$NEAR" "$@" 2>&1 || true; } | strip; }
# Run a near-cli transaction quietly (its output can name keys); print only the transaction hash or the failure line.
tx() {
  local what=$1; shift
  if [ "$GO" != 1 ]; then echo "  [dry] $what"; return 0; fi
  if "$NEAR" "$@" >"$LOG" 2>&1; then
    local h; h=$(strip <"$LOG" | grep -Eo 'Transaction ID: *[A-Za-z0-9]{40,50}' | head -1 | awk '{print $3}')
    echo "  ok  $what  tx ${h:-?}"
  else
    echo "  FAIL $what: $(strip <"$LOG" | grep -Ei 'error|panicked|E_[A-Z_]+' | grep -v -i 'key' | head -2 | cut -c1-200)" >&2
    return 1
  fi
}
# A U128 view result ("123"), or empty when the call failed (never a number scraped from an error message).
view_u128() { q contract call-function as-read-only "$CONTRACT" "$1" json-args "$2" network-config "$NET" now | grep -Ex '"[0-9]+"' | tail -1 | tr -d '"'; }
# Key helpers run in the web workspace (tsx): `pub` derives the public key of an env var's secret, `gen` writes a fresh key
# into .env.local and prints only its public key (captured, never shown).
keytool() { (cd "$ROOT/web" && ./node_modules/.bin/tsx --eval "
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { generateKeyPair, formatPublicKey, formatSecretKey, parseSecretKey } from './src/game/chain/keys'
const [op, name, file] = process.argv.slice(-3)
const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : []
const re = new RegExp('^\\\\s*' + name + '\\\\s*=\\\\s*(.*)\$')
if (op === 'pub') {
  const hit = lines.map((l) => re.exec(l)).find(Boolean)
  if (hit) { try { process.stdout.write(formatPublicKey(parseSecretKey(hit[1].trim().replace(/^[\"']|[\"']\$/g, '')).publicKey)) } catch {} }
} else {
  const kp = generateKeyPair()
  const kept = lines.filter((l) => !re.test(l))
  while (kept.length && kept[kept.length - 1] === '') kept.pop()
  kept.push(name + '=' + formatSecretKey(kp), '')
  writeFileSync(file, kept.join('\n')); chmodSync(file, 0o600)
  process.stdout.write(formatPublicKey(kp.publicKey))
}" -- "$1" "$2" "$ENVF"); }

echo "== house challengers on $CONTRACT (network $NET)$([ "$GO" = 1 ] || echo '  [DRY RUN: add --go to execute]')"
for h in a b; do
  ACC="house-$h.titleshot.testnet"
  VAR="HOUSE_$(echo "$h" | tr a-z A-Z)_KEY"
  echo "$ACC"
  SUMMARY=$(q account view-account-summary "$ACC" network-config "$NET" now)
  if grep -q 'does not exist' <<<"$SUMMARY"; then EXISTS=0; elif grep -q 'Access keys' <<<"$SUMMARY"; then EXISTS=1; else echo "  cannot tell whether $ACC exists (RPC error?): try --network testnet-fastnear" >&2; exit 1; fi
  # 1. account (full-access key saved to the legacy keychain)
  if [ "$EXISTS" = 1 ]; then echo "  exists"; else
    tx "create $ACC with $FUND NEAR from $OWNER" account create-account fund-myself "$ACC" "$FUND NEAR" autogenerate-new-keypair save-to-legacy-keychain sign-as "$OWNER" "${SIGN[@]}"
  fi
  # 2. game balance (before the function-call key exists, so the keychain signs with the full-access key)
  BAL=0; [ "$EXISTS" = 1 ] && BAL=$(view_u128 balance_of "{\"account\":\"$ACC\"}")
  [ -n "$BAL" ] || { echo "  cannot read the game balance of $ACC (RPC error?)" >&2; exit 1; }
  if [ "$BAL" != 0 ]; then echo "  game balance already $BAL yocto"; else
    tx "deposit $DEPOSIT NEAR into $CONTRACT" contract call-function as-transaction "$CONTRACT" deposit json-args '{}' prepaid-gas '30 Tgas' attached-deposit "$DEPOSIT NEAR" sign-as "$ACC" "${SIGN[@]}"
  fi
  # 3. function-call key for the Worker (receiver = contract, methods = [challenge])
  PUB=$(keytool pub "$VAR" || true)
  if [ -n "$PUB" ] && [ "$EXISTS" = 1 ] && q account list-keys "$ACC" network-config "$NET" now | grep -qF "$PUB"; then echo "  $VAR already on chain"; continue; fi
  if [ "$GO" != 1 ]; then echo "  [dry] new $VAR in .env.local + add-key (challenge on $CONTRACT, allowance $ALLOWANCE NEAR)"; continue; fi
  PUB=$(keytool gen "$VAR")
  tx "add function-call key ($VAR) for challenge on $CONTRACT" account add-key "$ACC" grant-function-call-access --allowance "$ALLOWANCE NEAR" --contract-account-id "$CONTRACT" --function-names challenge use-manually-provided-public-key "$PUB" "${SIGN[@]}"
done
echo "== done. Next: wrangler pages secret put HOUSE_A_KEY / HOUSE_B_KEY (values from .env.local) for project title-shot"
