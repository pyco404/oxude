#!/usr/bin/env bash
# Runs the settlement program's tests against a local validator.
#
#   scripts/chain-test.sh          # skips cleanly if the toolchain isn't here
#   CHAIN_REQUIRED=1 scripts/chain-test.sh   # fails instead of skipping
#
# Why it exists: `npm run check` runs this, so a change to the program - or to
# the client that builds its instructions - cannot land without the real
# bytecode having been exercised. It takes about a minute.
#
# Unlike scripts/pg-test.sh, missing prerequisites are a **skip, not a
# failure**. Postgres is one apt install; the Solana toolchain and a built
# program are a much larger ask, and someone working on the web app or the
# engine should not be stopped by it. The skip is loud - it says what is
# missing and how to get it - so it can never be mistaken for a pass.
set -euo pipefail
cd "$(dirname "$0")/.."

SO="chain/target/deploy/oxude_settlement.so"

skip() {
  echo ""
  echo "  ── chain tests SKIPPED ──────────────────────────────────"
  echo "  $1"
  echo "  $2"
  echo "  ─────────────────────────────────────────────────────────"
  echo ""
  if [ -n "${CHAIN_REQUIRED:-}" ]; then
    echo "CHAIN_REQUIRED is set, so this is a failure."
    exit 1
  fi
  exit 0
}

command -v solana-test-validator >/dev/null 2>&1 || skip \
  "No solana-test-validator on PATH, so the program was not exercised." \
  "Install the Solana CLI (https://solana.com/docs/intro/installation) to run these."

[ -f "$SO" ] || skip \
  "The program has not been built, so there is no bytecode to test." \
  "Run 'npm run chain:build' (needs Rust and Anchor 0.32.1)."

# Stale bytecode is the quiet failure this whole script exists to avoid: the
# tests would pass against a program nobody is going to ship. A warning rather
# than a refusal, because a comment-only edit moves the source and not the
# binary, and stopping the suite for that would teach people to skip it.
if [ -n "$(find chain/programs -name '*.rs' -newer "$SO" -print -quit)" ]; then
  echo ""
  echo "  ── WARNING: $SO is older than the Rust sources ──"
  echo "  These tests are about to run against bytecode built before the"
  echo "  current source. If you changed anything but comments, stop and run"
  echo "  'npm run chain:build' first."
  echo ""
fi

CHAIN=1 npx vitest run test/chain.test.ts
