#!/usr/bin/env bash
# Deploys the deposit-funded settlement program with the project's own keys -
# never the machine's default wallet - then initialises it.
#
#   scripts/chain-deploy.sh devnet
#   scripts/chain-deploy.sh http://127.0.0.1:18899
#
# The seed-funded program at EKJHJ8js... is frozen and is never redeployed from
# here; its keypair is not this one. See src/chain/seed-settlement.ts.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${1:-devnet}"
case "$CLUSTER" in
  devnet) RPC="https://api.devnet.solana.com" ;;
  *) RPC="$CLUSTER" ;;
esac

ADMIN=.keys/admin.json
PROGRAM_KEY="${CHAIN_PROGRAM_KEYPAIR:-.keys/program-v2.json}"
SO=chain/target/deploy/oxude_settlement.so
# Room to grow. The CLI allocates exactly the binary's length by default, which
# leaves none at all, and growing later needs `solana program extend` and more
# SOL. 600 KB is about 164 KB of headroom on a 436 KB program.
MAX_LEN="${CHAIN_MAX_LEN:-600000}"

[ -f "$SO" ] || { echo "Build first: npm run chain:build"; exit 1; }
[ -f "$PROGRAM_KEY" ] || { echo "No program keypair at $PROGRAM_KEY."; exit 1; }

# The keypair must be the one the built program declares, or this would deploy
# to an address the client never talks to - or, worse, over another program.
DECLARED=$(grep -o '"address": "[^"]*"' src/chain/idl.json | head -1 | sed 's/.*: "//; s/"$//')
ACTUAL=$(solana-keygen pubkey "$PROGRAM_KEY")
if [ "$DECLARED" != "$ACTUAL" ]; then
  echo "The program keypair does not match the built program."
  echo "  declare_id! in the build   $DECLARED"
  echo "  $PROGRAM_KEY               $ACTUAL"
  echo "Deploying would put this build at the wrong address. Fix declare_id! or point CHAIN_PROGRAM_KEYPAIR at the right key."
  exit 1
fi

SO_BYTES=$(stat -c%s "$SO")
DEPLOYED=$(solana program show "$ACTUAL" --url "$RPC" 2>/dev/null | awk '/Data Length/ {print $3}' || true)

rent() { solana rent "$1" --url "$RPC" | awk '/Rent-exempt minimum/ {print $3}'; }

if [ -z "$DEPLOYED" ]; then
  # A first deploy: the program account is created at MAX_LEN, and a buffer the
  # size of the binary exists alongside it until the deploy succeeds.
  PROGRAM_RENT=$(rent "$MAX_LEN")
  BUFFER_RENT=$(rent "$SO_BYTES")
  NEEDED=$(awk -v a="$PROGRAM_RENT" -v b="$BUFFER_RENT" 'BEGIN { printf "%.4f", a + b + 0.1 }')
  LEN_ARG=(--max-len "$MAX_LEN")
  WHAT="first deploy at --max-len $MAX_LEN"
else
  # An upgrade: the program account already exists and cannot be resized here.
  # --max-len is rejected on an upgrade; `solana program extend` is the way.
  PROGRAM_RENT=0
  BUFFER_RENT=$(rent "$SO_BYTES")
  NEEDED=$(awk -v b="$BUFFER_RENT" 'BEGIN { printf "%.4f", b + 0.1 }')
  LEN_ARG=()
  WHAT="upgrade of a program allocated $DEPLOYED bytes"
  if [ "$SO_BYTES" -gt "$DEPLOYED" ]; then
    echo "The build is $SO_BYTES bytes and the deployed account holds $DEPLOYED."
    echo "Extend it first, then run this again:"
    echo "  solana program extend $ACTUAL $((SO_BYTES - DEPLOYED + 65536)) --url $RPC --keypair $ADMIN"
    exit 1
  fi
fi

BALANCE=$(solana balance "$(solana-keygen pubkey $ADMIN)" --url "$RPC" | awk '{print $1}')
echo "cluster  $RPC"
echo "program  $ACTUAL  ($WHAT)"
echo "binary   $SO_BYTES bytes"
echo "admin    $(solana-keygen pubkey $ADMIN)  $BALANCE SOL"

if awk -v h="$BALANCE" -v n="$NEEDED" 'BEGIN { exit !(h < n) }'; then
  SHORT=$(awk -v h="$BALANCE" -v n="$NEEDED" 'BEGIN { printf "%.4f", n - h }')
  echo
  echo "Not enough SOL on the admin key. Nothing has been sent."
  printf '  program account       %10s SOL\n' "$PROGRAM_RENT"
  printf '  deploy buffer         %10s SOL  (refunded when the deploy succeeds)\n' "$BUFFER_RENT"
  printf '  fees and margin       %10s SOL\n' "0.1"
  printf '  needed                %10s SOL\n' "$NEEDED"
  printf '  have                  %10s SOL\n' "$BALANCE"
  printf '  short by              %10s SOL\n' "$SHORT"
  echo
  echo "Fund $(solana-keygen pubkey $ADMIN), then run this again."
  echo "Devnet: https://faucet.solana.com"
  exit 1
fi

# Buffer writes go straight to validators (the default TPU path). Public
# devnet drops some of them, so allow many retry rounds for the dropped ones,
# with a small priority fee. Do not add --use-rpc: sending ~300 writes through
# the public RPC gets throttled with 429s and never finishes.
# If a deploy still fails, close the stranded buffer to recover its SOL:
#   solana program show --buffers --buffer-authority <ADMIN> --url <RPC>
#   solana program close <BUFFER> --keypair .keys/admin.json --url <RPC> --bypass-warning
solana program deploy "$SO" --program-id "$PROGRAM_KEY" --keypair "$ADMIN" --url "$RPC" \
  "${LEN_ARG[@]}" --max-sign-attempts 100 --with-compute-unit-price 10000
CHAIN_RPC_URL="$RPC" npx tsx scripts/chain-setup.ts
