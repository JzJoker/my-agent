#!/usr/bin/env bash
# Runs ON the deploy host (invoked by scripts/deploy.sh over SSH).
# Converges the checkout to origin/main, reinstalls deps, restarts the service.
# No sudo.
set -euo pipefail

# A non-interactive SSH shell does NOT source ~/.bashrc, so fnm and the user
# systemd bus aren't set up. Wire them explicitly.
export PATH="$HOME/.local/share/fnm:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
eval "$(fnm env)"

cd "$HOME/my-agent"

# Source of truth = origin/main. Converge to it exactly (gitignored .env/data/ untouched).
git fetch --quiet origin
git reset --hard origin/main

fnm use --install-if-missing            # honor .node-version
fnm default "$(cat .node-version)"      # keep the service's stable alias current
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

systemctl --user restart my-agent
echo "✅ deployed $(git rev-parse --short HEAD) — $(git log -1 --pretty=%s)"
