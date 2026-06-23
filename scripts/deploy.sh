#!/usr/bin/env bash
# One-command deploy. Run from the repo root on your Mac:
#   ./scripts/deploy.sh "optional commit message"
# Pushes main to GitHub, then has the deploy host converge to it.
# Override the SSH target with DEPLOY_HOST=... (defaults to the `homelab` ssh alias).
set -euo pipefail

HOST="${DEPLOY_HOST:-homelab}"

# If a message is given, commit everything first. Otherwise deploy what's committed.
if [ -n "${1:-}" ]; then
  git add -A
  git commit -m "$1"
fi

git push origin main
ssh "$HOST" 'bash ~/my-agent/scripts/deploy-remote.sh'
