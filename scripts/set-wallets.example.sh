#!/usr/bin/env bash
#
# set-wallets.sh — reset the bot's wallets on Railway to EXACTLY the set defined
# below. Every run is idempotent: it CLEARS all existing wallet variables and the
# persisted state (per-wallet armed flags + positions), then applies only the
# wallets listed here, then redeploys.
#
#   Usage:
#     cp scripts/set-wallets.example.sh scripts/set-wallets.sh   # gitignored copy
#     # edit scripts/set-wallets.sh — fill in real LABEL|KEY lines
#     bash scripts/set-wallets.sh
#
# ⚠️  SECURITY: the real copy contains PRIVATE KEYS. Keep it OUT of git
#     (scripts/set-wallets.sh is gitignored). Never commit real keys.
#
# Notes:
#   - All wallets load SAFE (disarmed). Arm them in the dashboard to trade.
#   - This does NOT touch DRY_RUN / DASHBOARD_PASSWORD / SLACK_WEBHOOK.
#   - Requires: railway CLI logged in, and this dir linked to the project.
set -euo pipefail

# ============================ CONFIG ============================
SERVICE="automation"               # Railway service name
STATE_PATH="/data/bot-state.json"  # must match BOT_STATE_PATH on Railway
RESET_STATE=true                   # wipe persisted armed flags/positions on reset
SENTINEL="EMPTY"                   # value used to clear a slot (bot treats as no-wallet;
                                   # Railway's CLI can't store a truly empty value)

# ===================== DEFINE YOUR WALLETS ======================
# One per line as  "Label|<64 hex private key>".  The 0x prefix is OPTIONAL.
WALLETS=(
  "Main|REPLACE_WITH_REAL_64_HEX_PRIVATE_KEY_000000000000000000000000"
  "Alt|REPLACE_WITH_REAL_64_HEX_PRIVATE_KEY_000000000000000000000000"
  # "Whale|0x...."
)
# ================================================================

declare -a KEYS=() LABELS=()
for entry in "${WALLETS[@]}"; do
  label="${entry%%|*}"
  key="${entry#*|}"
  # Normalize: trim and ensure a 0x prefix before validating.
  key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
  [[ "$key" =~ ^0[xX] ]] || key="0x${key}"
  if [[ ! "$key" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    echo "ERROR: wallet '$label' — key must be 64 hex chars (0x prefix optional)." >&2
    exit 1
  fi
  LABELS+=("$label")
  KEYS+=("$key")
done

COUNT=${#KEYS[@]}
if (( COUNT == 0 )); then echo "ERROR: no wallets defined." >&2; exit 1; fi

# Discover which wallet slots are ALREADY set on Railway (so we clear leftovers
# from a previous run). We extract only slot numbers — never values.
EXISTING=$(railway variables --service "$SERVICE" --kv 2>/dev/null \
  | sed -nE 's/^WALLET_([0-9]+)_(KEY|LABEL)=.*/\1/p' | sort -un)

echo "Setting ${COUNT} wallet(s) on '${SERVICE}'; clearing any leftover slots."

# slots 1..COUNT get the real wallets; existing slots beyond COUNT get the
# sentinel (CLI-accepted non-empty value the bot ignores).
SET_ARGS=()
for (( j=1; j<=COUNT; j++ )); do
  idx=$(( j - 1 ))
  SET_ARGS+=( --set "WALLET_${j}_KEY=${KEYS[$idx]}" --set "WALLET_${j}_LABEL=${LABELS[$idx]}" )
done
for e in $EXISTING; do
  if (( e > COUNT )); then
    SET_ARGS+=( --set "WALLET_${e}_KEY=${SENTINEL}" --set "WALLET_${e}_LABEL=${SENTINEL}" )
  fi
done

# Apply variables without an intermediate deploy (we deploy once at the end).
railway variables --service "$SERVICE" --skip-deploys "${SET_ARGS[@]}" >/dev/null
echo "✓ wallet variables applied."

# Wipe persisted state so the new wallet set starts clean (all SAFE, no positions).
if [[ "$RESET_STATE" == "true" ]]; then
  if railway ssh --service "$SERVICE" "rm -f '$STATE_PATH'" >/dev/null 2>&1; then
    echo "✓ persisted state wiped ($STATE_PATH)."
  else
    echo "! could not wipe state via ssh (container restarting?). New wallets may"
    echo "  inherit a prior slot's armed flag — re-run this script once it's up if so."
  fi
fi

# Redeploy to load the new wallet set.
railway redeploy -y >/dev/null
echo "✓ redeploy triggered. Wallets load in ~1 min, all SAFE until armed in the dashboard."
echo
echo "Verify with:  railway logs   (look for 'wallets=${COUNT}')"
