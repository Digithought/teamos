#!/bin/sh
# TeamOS container entrypoint.
#
# Clones (or pulls) a host project into the workspace volume, configures git
# credentials, optionally starts a VSCode `code tunnel` for remote development,
# then execs the runner. All host-project specifics come from environment
# variables — nothing here is hard-coded.
#
# Required env:
#   TEAMOS_REPO_URL          HTTPS URL of the host project git repo
#
# Optional env:
#   TEAMOS_REPO_BRANCH       Branch to track (default: main)
#   TEAMOS_REPO_DIR          Where to clone (default: /workspace/repo)
#   GITHUB_TOKEN             PAT for HTTPS clone/push against github.com
#   GIT_AUTHOR_NAME          Commit author name (default: teamos-runner)
#   GIT_AUTHOR_EMAIL         Commit author email (default: runner@teamos.local)
#   TEAMOS_TUNNEL_NAME       If set, runs `code tunnel --name <value>` in background
#
# Required secrets (set via `fly secrets set`):
#   CLAUDE_CODE_OAUTH_TOKEN  Subscription auth for the Claude CLI (read by the
#                            CLI directly; this script doesn't touch it)

set -e

: "${TEAMOS_REPO_URL:?TEAMOS_REPO_URL is required}"
REPO_DIR="${TEAMOS_REPO_DIR:-/workspace/repo}"
BRANCH="${TEAMOS_REPO_BRANCH:-main}"

# Configure git identity and credentials before any clone/push.
git config --global user.name  "${GIT_AUTHOR_NAME:-teamos-runner}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-runner@teamos.local}"

if [ -n "$GITHUB_TOKEN" ]; then
	git config --global credential.helper store
	# `x-access-token` is GitHub's documented user for PAT-over-HTTPS auth.
	# Storing here keeps the token out of the remote URL written to .git/config.
	echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > "$HOME/.git-credentials"
	chmod 600 "$HOME/.git-credentials"
fi

if [ ! -d "$REPO_DIR/.git" ]; then
	echo "[entrypoint] cloning $TEAMOS_REPO_URL ($BRANCH) -> $REPO_DIR"
	git clone -b "$BRANCH" --recurse-submodules "$TEAMOS_REPO_URL" "$REPO_DIR"
else
	echo "[entrypoint] updating $REPO_DIR ($BRANCH)"
	git -C "$REPO_DIR" fetch origin "$BRANCH" || true
	git -C "$REPO_DIR" checkout "$BRANCH" || true
	git -C "$REPO_DIR" pull --ff-only || true
	git -C "$REPO_DIR" submodule update --init --recursive || true
fi

cd "$REPO_DIR"

if [ -n "$TEAMOS_TUNNEL_NAME" ]; then
	echo "[entrypoint] starting code tunnel: $TEAMOS_TUNNEL_NAME"
	code tunnel --accept-server-license-terms --name "$TEAMOS_TUNNEL_NAME" \
		>/workspace/tunnel.log 2>&1 &
fi

echo "[entrypoint] starting teamos runner: $*"
exec node teamos/scripts/run.mjs "$@"
