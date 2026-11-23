#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Removes what install.sh installed for the current user. With --all, also
# removes the scene renderer, the downloaded scene assets, SteamCMD with its
# saved Steam sign-in, the still image and the caches.

set -euo pipefail

DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"
APP_DIR="$DATA_DIR/nekoland-paper-engine/app"
DAEMON="gjs -m $APP_DIR/daemon.js"

case "${1:-}" in
    '') all=false ;;
    --all) all=true ;;
    *) echo "Usage: $0 [--all]" >&2; exit 2 ;;
esac

pkill -f "^$DAEMON" 2>/dev/null || true
if config="$(nekoland msg config 2>/dev/null)"; then
    autostart="$(python3 -c '
import json, sys, tomllib
autostart = tomllib.loads(sys.stdin.read()).get("autostart", [])
if sys.argv[1] in autostart:
    print(json.dumps([command for command in autostart if command != sys.argv[1]]))' "$DAEMON" <<<"$config")"
    [[ -z "$autostart" ]] || nekoland msg "set autostart = $autostart"
    # The still image may be Nekoland's wallpaper; deleting it would leave none.
    if $all && [[ "$config" == *"wallpaper = \"$DATA_DIR/nekoland-paper-engine/still-"* ]]; then
        nekoland msg "unset wallpaper"
    fi
else
    echo "Nekoland is not running here: take \"$DAEMON\" out of autostart in ~/.config/nekoland/config.toml."
fi
rm -rf "$APP_DIR" \
       "$DATA_DIR/applications/io.github.koukeneko.Nekoland.PaperEngine.desktop" \
       "$DATA_DIR/icons/hicolor/scalable/apps/nekoland-paper-engine.svg"

if $all; then
    rm -rf "$DATA_DIR/nekoland-paper-engine" "$CACHE_DIR/nekoland-paper-engine"
    echo "Removed, with the scene renderer, scene assets and SteamCMD."
else
    echo "Removed. The scene renderer, scene assets and SteamCMD stay in $DATA_DIR/nekoland-paper-engine; run with --all to remove them too."
fi
