#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Removes what install.sh installed for the current user. With --all, also
# removes the scene renderer, the downloaded scene assets, SteamCMD with its
# saved Steam sign-in, and the caches.

set -euo pipefail

UUID=gnome-paper-engine@koukeneko.github.io
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}"

case "${1:-}" in
    '') all=false ;;
    --all) all=true ;;
    *) echo "Usage: $0 [--all]" >&2; exit 2 ;;
esac

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$DATA_DIR/gnome-shell/extensions/$UUID" \
       "$DATA_DIR/applications/gnome-paper-engine.desktop" \
       "$DATA_DIR/icons/hicolor/scalable/apps/gnome-paper-engine.svg"

if $all; then
    # The still image may be the desktop background; deleting it would leave none.
    for key in picture-uri picture-uri-dark; do
        if [[ "$(gsettings get org.gnome.desktop.background "$key")" == *gnome-paper-engine/still.png* ]]; then
            gsettings reset org.gnome.desktop.background "$key"
        fi
    done
    rm -rf "$DATA_DIR/gnome-paper-engine" "$CACHE_DIR/gnome-paper-engine"
    echo "Removed, with the scene renderer, scene assets and SteamCMD."
else
    echo "Removed. The scene renderer, scene assets and SteamCMD stay in $DATA_DIR/gnome-paper-engine; run with --all to remove them too."
fi
if [[ -d /usr/share/gnome-shell/extensions/$UUID ]]; then
    echo "The .deb package is still installed; remove it with: sudo apt remove gnome-paper-engine"
fi
echo "Log out and back in to unload the extension from the running GNOME Shell."
