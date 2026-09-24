#!/usr/bin/env bash
# Runs the tests that need a real Postgres.
#
#   scripts/pg-test.sh                 # throwaway cluster, started and removed here
#   scripts/pg-test.sh test/db.test.ts # ... against a file of your choosing
#   PG_URL=postgres://... scripts/pg-test.sh    # against a server you already have
#
# Why it exists: the suite runs on PGlite and production runs on node-postgres,
# and the two disagree about int8 (see CLAUDE.md). Anything reading a bigint out
# of raw SQL has to be checked against the real driver, and test/postgres.test.ts
# is where those checks live - it skips itself unless PG_URL is set, so an
# ordinary `npm run check` stays offline.
#
# No docker and no root: it uses the postgres binaries already on the machine to
# start a cluster in a temporary directory on a spare port, and removes it
# afterwards whether the tests passed or not. The machine's own Postgres, if it
# has one, is never touched.
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-test/postgres.test.ts}"

if [ -n "${PG_URL:-}" ]; then
  echo "Using the server in PG_URL"
  PG_URL="$PG_URL" npx vitest run "$TARGET"
  exit $?
fi

PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
if [ -z "$PGBIN" ] || [ ! -x "$PGBIN/initdb" ]; then
  echo "No Postgres binaries found."
  echo "Either install them (Debian/Ubuntu: sudo apt install postgresql), or point PG_URL at a server:"
  echo "  PG_URL=postgres://user:pass@host:5432/db scripts/pg-test.sh"
  exit 1
fi

PORT="${PGPORT:-55432}"
DIR=$(mktemp -d)
cleanup() {
  "$PGBIN/pg_ctl" -D "$DIR/data" stop -m immediate >/dev/null 2>&1 || true
  rm -rf "$DIR"
}
trap cleanup EXIT

echo "Starting a throwaway Postgres on port $PORT ($("$PGBIN/postgres" --version))"
"$PGBIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
# No Unix socket: its path would have to fit in 107 bytes, and a temporary
# directory's often does not. Everything here connects over TCP on loopback.
"$PGBIN/pg_ctl" -D "$DIR/data" -l "$DIR/log" \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" start >/dev/null
"$PGBIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -d postgres \
  -c "create role oxude login password 'oxude' superuser" >/dev/null

PG_URL="postgres://oxude:oxude@127.0.0.1:$PORT/postgres" npx vitest run "$TARGET"
