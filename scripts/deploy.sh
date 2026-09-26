#!/usr/bin/env bash
# Deploys a service from HEAD, and only from HEAD.
#
#   scripts/deploy.sh api
#   scripts/deploy.sh web
#
# Why it exists: `railway up` uploads the *working tree*, not the commit. With
# two sessions editing one checkout that is not a theory - oxude.xyz has
# already run code that was in nobody's git history, which means "what is
# live?" had no answer but "look at the files as they were at 16:27".
#
# So this refuses a dirty tree, refuses an unpushed HEAD, and stages the web
# app with `git archive HEAD` rather than tar-ing the directory. After it runs,
# the commit it printed is what is live.
set -euo pipefail
cd "$(dirname "$0")/.."

SERVICE="${1:-}"
case "$SERVICE" in
  api|web) ;;
  *) echo "usage: scripts/deploy.sh api|web"; exit 1 ;;
esac

PROJECT=af965879-57de-4ff2-89a0-efc0c9863fcd
ENVIRONMENT=production

# The two services differ in what an uncommitted file means, so they differ in
# what happens about one. For the api the working tree *is* the upload, so a
# dirty tree would ship files that are in nobody's history: refused. For web
# the upload comes from `git archive HEAD`, so uncommitted work cannot ship -
# the risk is the opposite one, someone expecting their edit to be live. Said
# loudly, and carried on.
DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  if [ "$SERVICE" = "api" ] && [ -z "${DEPLOY_DIRTY:-}" ]; then
    echo "The working tree has changes that are not committed:"
    echo "$DIRTY" | sed 's/^/  /'
    echo
    echo "railway up uploads files, not commits, so this would ship them and leave"
    echo "nothing in git saying what is live. Commit or stash them first."
    echo "DEPLOY_DIRTY=1 overrides this, and you should have a reason."
    exit 1
  fi
  echo "NOTE: these changes are NOT being deployed - this ships HEAD:"
  echo "$DIRTY" | sed 's/^/  /'
  echo
fi

HEAD_SHA=$(git rev-parse HEAD)
if [ -z "${DEPLOY_UNPUSHED:-}" ]; then
  git fetch --quiet origin main 2>/dev/null || true
  if ! git merge-base --is-ancestor "$HEAD_SHA" origin/main 2>/dev/null; then
    echo "HEAD is not on origin/main, so what this deploys could not be fetched back."
    echo "  HEAD    $(git log --oneline -1 | cat)"
    echo "Push first, or set DEPLOY_UNPUSHED=1."
    exit 1
  fi
fi

echo "service  $SERVICE"
echo "commit   $(git log --oneline -1 | cat)"

if [ "$SERVICE" = "api" ]; then
  # The tree is clean, so the upload is HEAD. The root railway.json is the
  # api's config, which is why this one deploys from here.
  railway up --service api --ci
  exit $?
fi

# The web service has its Root Directory set to /web, so the upload has to
# contain a web/ directory - see README. git archive gives us exactly the
# committed subtree, with no chance of a stray working-tree file riding along.
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD web | tar -x -C "$STAGE"
# web/app/exit-panel.tsx imports from web/public/exit, which git archive
# already carried; nothing outside web/ is needed.
[ -f "$STAGE/web/package.json" ] || { echo "staging produced no web/package.json"; exit 1; }
# So that "is production HEAD?" has an answer anyone can check, rather than
# being something you have to trust this script about.
printf '%s\n' "$HEAD_SHA" > "$STAGE/web/public/commit.txt"
echo "staged   $(find "$STAGE/web" -type f | wc -l) files from $HEAD_SHA"
echo "check    curl https://oxude.xyz/commit.txt"

cd "$STAGE"
railway up -s web --ci --project "$PROJECT" --environment "$ENVIRONMENT"
