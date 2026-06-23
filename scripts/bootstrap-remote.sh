#!/usr/bin/env bash
# One-time setup on the deploy host. Run once, interactively from an SSH session.
# Needs sudo ONCE (for linger); nothing else does. Idempotent — safe to re-run.
set -euo pipefail

export PATH="$HOME/.local/share/fnm:$PATH"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
eval "$(fnm env)"

cd "$HOME/my-agent"

# 1. Node per .node-version, kept as the stable `default` alias the unit points at.
NODE_V="$(cat .node-version)"
fnm install "$NODE_V" || true           # latest patch of the pinned major
fnm use "$NODE_V"
fnm default "$NODE_V"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile

# 2. Install the systemd *user* unit from the versioned copy.
mkdir -p "$HOME/.config/systemd/user"
cp deploy/my-agent.service "$HOME/.config/systemd/user/my-agent.service"
systemctl --user daemon-reload

# 3. Linger: run the user service at boot without anyone logged in. (sudo, one-time.)
sudo loginctl enable-linger "$USER"

# 4. Enable + start, then show status.
systemctl --user enable --now my-agent
sleep 2
systemctl --user --no-pager status my-agent | head -n 8
