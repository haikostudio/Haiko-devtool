#!/usr/bin/env bash
# Sync the self-host fork with upstream open-source Paseo.
#
# Rebases the thin custom self-host layer (autostart, CI, image compression,
# relay chunking) on top of the latest upstream `origin/main`, verifies the web
# build (exactly what the deploy CI runs), and pushes the rebased branch to the
# fork so `build-web-selfhost.yml` rebuilds the artifact.
#
# Designed to be run by the weekly scheduled agent. On a clean rebase it does the
# whole thing unattended. On conflict it aborts and exits non-zero with a clear
# message so the agent can resolve conflicts, keeping the custom layer intact.
#
# It never touches the live site: deployment stays an explicit follow-up
# (`/home/paseo/paseo-app-deploy.sh`) so upstream changes are reviewed before
# going to app.haikostudio.cloud.
set -euo pipefail

REPO_DIR="/root/paseo"
BRANCH="feat/github-repo-picker"      # the deployed self-host branch (see paseo-app-deploy.sh)
UPSTREAM="origin/main"                 # origin = getpaseo/paseo (open source)
FORK="fork"                            # fork = haikostudio/paseo

cd "$REPO_DIR"

log() { printf '==> %s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Refuse to run on a dirty tree — a rebase would clobber uncommitted work.
if [ -n "$(git status --porcelain)" ]; then
  fail "working tree not clean; commit or stash before syncing"
fi

git rev-parse --verify --quiet "$BRANCH" >/dev/null || fail "branch $BRANCH not found"
git checkout "$BRANCH"

log "Fetching upstream ($UPSTREAM)..."
git fetch origin --prune

BEHIND="$(git rev-list --count "HEAD..$UPSTREAM")"
if [ "$BEHIND" -eq 0 ]; then
  log "Already up to date with $UPSTREAM. Nothing to do."
  exit 0
fi
log "$BEHIND new upstream commit(s). Rebasing the custom layer..."

# Safety net: tag the pre-rebase tip so a bad rebase is always recoverable.
git tag -f "pre-sync-backup" HEAD >/dev/null
log "Backup tag 'pre-sync-backup' -> $(git rev-parse --short HEAD)"

if ! git rebase "$UPSTREAM"; then
  git rebase --abort || true
  fail "rebase hit conflicts and was aborted. Resolve manually (custom layer must win for relay/attachments/ops/CI), then re-run. Backup at tag pre-sync-backup."
fi
log "Rebase clean. Custom layer now on top of $(git rev-parse --short "$UPSTREAM")."

# Upstream may have changed dependencies; refresh before building.
log "Installing dependencies..."
sudo npm install >/dev/null 2>&1 || npm install >/dev/null 2>&1 || fail "npm install failed"

log "Rebuilding client + server declarations..."
npm run build:client >/dev/null 2>&1 || fail "build:client failed"
npm run build:server >/dev/null 2>&1 || fail "build:server failed"

log "Verifying web build (the CI-critical check)..."
npm run build:web --workspace=@getpaseo/app >/dev/null 2>&1 || fail "build:web failed — do NOT push; investigate"

log "Verification green. Pushing rebased branch to $FORK..."
git push "$FORK" "$BRANCH" --force-with-lease

log "Done. CI (build-web-selfhost.yml) will rebuild the artifact."
log "To publish to the live site, run: /home/paseo/paseo-app-deploy.sh"
