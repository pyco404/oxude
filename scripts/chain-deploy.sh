#!/usr/bin/env bash
# Deploys the settlement program with the project's own keys - never the
# machine's default wallet - then initialises it.
#
#   scripts/chain-deploy.sh devnet
#   scripts/chain-deploy.sh http://127.0.0.1:18899
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${1:-devnet}"
case "$CLUSTER" in
  devnet) RPC="https://api.devnet.solana.com" ;;
  *) RPC="$CLUSTER" ;;
esac

ADMIN=.keys/admin.json
PROGRAM_KEY=chain/target/deploy/oxude_settlement-keypair.json
SO=chain/target/deploy/oxude_settlement.so
[ -f "$SO" ] || { echo "Build first: npm run chain:build"; exit 1; }

BALANCE=$(solana balance "$(solana-keygen pubkey $ADMIN)" --url "$RPC" | awk '{print $1}')
echo "admin $(solana-keygen pubkey $ADMIN) has $BALANCE SOL on $RPC"
awk -v b="$BALANCE" 'BEGIN { exit !(b < 3) }' && {
  echo "Deploying needs about 3 SOL on the admin key. Fund $(solana-keygen pubkey $ADMIN) first."
  echo "Devnet: https://faucet.solana.com"
  exit 1
}

# Buffer writes go straight to validators (the default TPU path). Public
# devnet drops some of them, so allow many retry rounds for the dropped ones,
# with a small priority fee. Do not add --use-rpc: sending ~300 writes through
# the public RPC gets throttled with 429s and never finishes.
# If a deploy still fails, close the stranded buffer to recover its ~1.5 SOL:
#   solana program show --buffers --buffer-authority <ADMIN> --url <RPC>
#   solana program close <BUFFER> --keypair .keys/admin.json --url <RPC> --bypass-warning
solana program deploy "$SO" --program-id "$PROGRAM_KEY" --keypair "$ADMIN" --url "$RPC" \
  --max-sign-attempts 100 --with-compute-unit-price 10000
CHAIN_RPC_URL="$RPC" npx tsx scripts/chain-setup.ts
