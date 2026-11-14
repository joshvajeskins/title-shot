#!/usr/bin/env bash
# COORDINATOR ONLY (spends testnet NEAR): creates <account> from titleshot.testnet, deploys contract/res/titleshot.wasm, calls `new`,
# adds the relayer, creates the 3 belts and prints get_deploy_gates. Uses near-cli-rs (~/.cargo/bin/near) with the legacy keychain.
#
#   scripts/deploy-contract.sh <account> <staging|production> --fund <NEAR> [--dry-run] [--network <name>]
#
#   staging     relayer mode; the only AI signer is the stand-in key (STANDIN_SIGNER_KEY in .env.local, see gen-standin-key.mjs);
#               model 'standin/compiler-v1'; allowlist timelock 0. Example: staging.titleshot.testnet
#   production  outlayer mode; AI signer(s) = the live NEAR AI attestation report of $NEARAI_MODEL (public, no key needed);
#               project titleshot.testnet/titleshot-forge; allowlist timelock $ALLOWLIST_DELAY_SEC (default 3600).
#               Optional hardening when you have the values: VRF_PUBKEY_HEX=<ed25519 hex> FORGE_SECRETS_PROFILE=<profile>
#
#   --fund <NEAR>   REQUIRED. The new account's starting balance in NEAR (an explicit number: the wasm alone locks ~6.3 NEAR of storage,
#                   plus per-bout storage; check `near tokens titleshot.testnet view-near-balance` first). Nothing is guessed.
#   --dry-run       print every command (and the JSON args) and run none of them: no account, no deploy, no spend.
#   --network <n>   near-cli network connection (default testnet-drpc = https://near-testnet.drpc.org, added to the near-cli config if
#                   missing; use testnet-fastnear or testnet if you prefer, they 429 sooner).
#
# Re-runnable: an existing account is not created again, an initialised contract is not re-initialised, belts are only created up to 3.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
NEAR=${NEAR_BIN:-$HOME/.cargo/bin/near}
OWNER=titleshot.testnet
WASM=contract/res/titleshot.wasm
RELAYER=relay.titleshot.testnet
usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-2}"; }

ACCOUNT=${1:-}; MODE=${2:-}; [ -n "$ACCOUNT" ] && [ -n "$MODE" ] || usage
shift 2
FUND=""; DRY=0; NET=testnet-drpc
while [ $# -gt 0 ]; do
  case "$1" in
    --fund) FUND=${2:-}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --network) NET=${2:-}; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
case "$MODE" in staging|production) ;; *) echo "mode must be staging or production" >&2; exit 2 ;; esac
case "$ACCOUNT" in *.titleshot.testnet) ;; *) echo "account must be a sub-account of $OWNER (for example staging.titleshot.testnet)" >&2; exit 2 ;; esac
[[ "$FUND" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "--fund <NEAR> is required and must be a plain number (for example 8)" >&2; exit 2; }
[ -x "$NEAR" ] || { echo "near-cli-rs not found at $NEAR" >&2; exit 1; }
[ -f "$WASM" ] || { echo "$WASM missing: run contract/build.sh first" >&2; exit 1; }
export PATH=/usr/bin:$PATH AR=/usr/bin/ar CC=/usr/bin/clang

# Print a command with each argument quoted so it can be pasted; run it unless --dry-run.
show() { local o="+"; for a in "$@"; do case "$a" in *[!A-Za-z0-9_./:=@,+-]*|"") o+=" '${a//\'/\'\\\'\'}'" ;; *) o+=" $a" ;; esac; done; echo "$o"; }
run() { if [ "$DRY" = 1 ]; then show "$@"; else show "$@" | cut -c1-400; "$@"; fi; }
tsx() { pnpm --dir "$ROOT/web" exec tsx "$ROOT/scripts/contract-init-args.ts" "$@"; }
strip() { sed 's/\x1b\[[0-9;]*m//g'; }

echo "== $MODE contract $ACCOUNT (owner $OWNER, network $NET)$([ "$DRY" = 1 ] && echo '  [DRY RUN: nothing is executed]')"

# 0. network connection with a non-throttled RPC (near-cli has no non-interactive way to add one, so the config file is appended to)
CFG="$HOME/Library/Application Support/near-cli/config.toml"; [ -f "$CFG" ] || CFG="$HOME/.config/near-cli/config.toml"
if [ "$NET" = testnet-drpc ] && ! grep -q '^\[network_connection.testnet-drpc\]' "$CFG" 2>/dev/null; then
  BLOCK='
[network_connection.testnet-drpc]
network_name = "testnet"
rpc_url = "https://near-testnet.drpc.org/"
wallet_url = "https://testnet.mynearwallet.com/"
explorer_transaction_url = "https://explorer.testnet.near.org/transactions/"
linkdrop_account_id = "testnet"
near_social_db_contract_account_id = "v1.social08.testnet"
faucet_url = "https://helper.nearprotocol.com/account"
staking_pools_factory_account_id = "pool.f863973.m0"
mpc_contract_account_id = "v1.signer-prod.testnet"'
  echo "+ append the testnet-drpc connection to $CFG:$BLOCK"
  if [ "$DRY" != 1 ]; then cp "$CFG" "$CFG.bak-titleshot"; printf '%s\n' "$BLOCK" >> "$CFG"; fi
fi
SIGN=(network-config "$NET" sign-with-legacy-keychain send)

# 1. arguments (the init JSON embeds the request prefix/suffix of the wasm rulebook for this model)
NEW_ARGS=$(tsx new "$MODE") || { echo "could not build the init arguments" >&2; exit 1; }
echo "init arguments (request prefix/suffix abbreviated):"
printf '%s' "$NEW_ARGS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const k of ["req_prefix","req_suffix"])j[k]=j[k].slice(0,24)+"... ("+j[k].length+" base64 chars)";console.log(JSON.stringify(j,null,1))})'

# 2. account
view() { { "$NEAR" "$@" 2>&1 || true; } | strip; }
if [ "$DRY" = 1 ]; then EXISTS=0; echo "(dry run: assuming $ACCOUNT does not exist yet)"; else
  OUT=$(view account view-account-summary "$ACCOUNT" network-config "$NET" now)
  if grep -q 'does not exist' <<<"$OUT"; then EXISTS=0; elif grep -q 'Access keys' <<<"$OUT"; then EXISTS=1; else echo "cannot tell whether $ACCOUNT exists (RPC error?); try --network testnet-fastnear" >&2; exit 1; fi
fi
if [ "$EXISTS" = 1 ]; then echo "$ACCOUNT exists: not creating it"; else
  run "$NEAR" account create-account fund-myself "$ACCOUNT" "$FUND NEAR" autogenerate-new-keypair save-to-legacy-keychain sign-as "$OWNER" "${SIGN[@]}"
fi

# 3. deploy + init (skipped when the contract already answers get_config)
INIT=0
CFG_OUT=""
if [ "$DRY" != 1 ] && [ "$EXISTS" = 1 ]; then CFG_OUT=$(view contract call-function as-read-only "$ACCOUNT" get_config json-args '{}' network-config "$NET" now); fi
if grep -q '"model_id"' <<<"$CFG_OUT"; then INIT=1; fi
if [ "$INIT" = 1 ]; then echo "$ACCOUNT is already initialised: not deploying again"; else
  run "$NEAR" contract deploy "$ACCOUNT" use-file "$WASM" with-init-call new json-args "$NEW_ARGS" prepaid-gas '100 Tgas' attached-deposit '0 NEAR' "${SIGN[@]}"
fi

# 4. owner setters (1 yocto each, signed by the owner)
owner_call() { run "$NEAR" contract call-function as-transaction "$ACCOUNT" "$1" json-args "$2" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as "$OWNER" "${SIGN[@]}"; }
owner_call add_relayer "{\"acct\":\"$RELAYER\"}"
if [ "$MODE" = production ]; then
  [ -n "${VRF_PUBKEY_HEX:-}" ] && owner_call set_vrf_pubkey "{\"pubkey_hex\":\"$VRF_PUBKEY_HEX\"}"
  [ -n "${FORGE_SECRETS_PROFILE:-}" ] && owner_call set_forge_secrets "{\"profile\":\"$FORGE_SECRETS_PROFILE\",\"owner\":\"$OWNER\"}"
fi

# 5. belts (only the ones missing: belt_count from get_config)
HAVE=0
if [ "$DRY" != 1 ]; then
  CFG_OUT=$(view contract call-function as-read-only "$ACCOUNT" get_config json-args '{}' network-config "$NET" now)
  HAVE=$(sed -n 's/.*"belt_count": *\([0-9]*\).*/\1/p' <<<"$CFG_OUT" | head -1); HAVE=${HAVE:-0}
fi
for i in 1 2 3; do
  if [ "$HAVE" -ge "$i" ]; then echo "belt $i exists"; continue; fi
  owner_call create_belt "$(tsx belt "$i")"
done

# 6. what is still open before this contract may be called a deployment
echo "== get_deploy_gates"
[ "$MODE" = staging ] && echo "(staging: the only expected gate is forge_mode=relayer; the stand-in signer is $(tsx address))"
if [ "$DRY" = 1 ]; then run "$NEAR" contract call-function as-read-only "$ACCOUNT" get_deploy_gates json-args '{}' network-config "$NET" now; else
  show "$NEAR" contract call-function as-read-only "$ACCOUNT" get_deploy_gates json-args '{}' network-config "$NET" now
  GATES=$(view contract call-function as-read-only "$ACCOUNT" get_deploy_gates json-args '{}' network-config "$NET" now)
  # exits non-zero (and so does this script) when challenge() would refuse every call, or staging has an unexpected gate
  printf '%s' "$GATES" | node "$ROOT/scripts/check-gates.mjs" "$MODE"
fi
echo "== next: CONTRACT_ID=$ACCOUNT scripts/cf-deploy.sh $MODE   (and fund $ACCOUNT's endowment if get_solvency reports a deficit)"
