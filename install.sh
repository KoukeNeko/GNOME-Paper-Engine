#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Installs the extension for the current user and adds a "Wallpaper Engine"
# launcher that opens the wallpaper picker.

set -euo pipefail

UUID=gnome-wallpaper-engine@doeshing
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
EXTENSION_DIR="$DATA_DIR/gnome-shell/extensions/$UUID"

rm -rf "$EXTENSION_DIR"
mkdir -p "$EXTENSION_DIR" "$DATA_DIR/applications"
cp -r "$SOURCE_DIR/extension/." "$EXTENSION_DIR"
glib-compile-schemas --strict "$EXTENSION_DIR/schemas"

cat > "$DATA_DIR/applications/gnome-wallpaper-engine.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Wallpaper Engine
Comment=Choose a live wallpaper from your Steam Wallpaper Engine library
Exec=gnome-extensions prefs $UUID
Icon=preferences-desktop-wallpaper
Categories=Utility;GNOME;GTK;
Keywords=wallpaper;background;live;steam;
EOF

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Installed and enabled. Open “Wallpaper Engine” from the app grid to pick a wallpaper."
else
    # A running shell only discovers new extensions at login, so enable it for the next one.
    enabled="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$enabled" != *"'$UUID'"* ]]; then
        if [[ "$enabled" == "@as []" ]]; then
            gsettings set org.gnome.shell enabled-extensions "['$UUID']"
        else
            gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$UUID']"
        fi
    fi
    echo "Installed. Log out and back in once, then open “Wallpaper Engine” from the app grid."
fi
