#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Installs Paper Engine for the current user: the program into
# ~/.local/share/nekoland-paper-engine/app, a "Paper Engine" launcher that
# opens the wallpaper picker, and the daemon that plays the wallpaper into
# Nekoland's autostart. Run it again to update.

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APP_DIR="$DATA_DIR/nekoland-paper-engine/app"
DAEMON="gjs -m $APP_DIR/daemon.js"

# What the daemon, the renderers and the picker run with. gtk-layer-shell puts
# the renderers' surfaces under the windows; pulsesrc and the spectrum feed web
# wallpapers that show the sound; wpctl mutes scenes.
PACKAGES=(
    gjs gettext gir1.2-gtk-3.0 gir1.2-gtk-4.0 gir1.2-adw-1 gir1.2-webkit2-4.1 gir1.2-soup-3.0
    gir1.2-gtklayershell-0.1 gir1.2-gstreamer-1.0 gstreamer1.0-plugins-good gstreamer1.0-pulseaudio wireplumber
)
missing=()
for package in "${PACKAGES[@]}"; do
    dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' || missing+=("$package")
done
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "==> Installing ${missing[*]}"
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR" "$DATA_DIR/applications" "$DATA_DIR/icons/hicolor/scalable/apps"
cp -r "$SOURCE_DIR/src/." "$APP_DIR"
# The picker's install button runs the scene renderer setup from here.
cp -r "$SOURCE_DIR/setup-scene-renderer.sh" "$SOURCE_DIR/patches" "$APP_DIR"
glib-compile-schemas --strict "$APP_DIR/schemas"
for catalogue in "$SOURCE_DIR"/po/*.po; do
    language="$(basename "$catalogue" .po)"
    mkdir -p "$APP_DIR/locale/$language/LC_MESSAGES"
    msgfmt --check -o "$APP_DIR/locale/$language/LC_MESSAGES/nekoland-paper-engine.mo" "$catalogue"
done
cp "$SOURCE_DIR/icons/nekoland-paper-engine.svg" "$DATA_DIR/icons/hicolor/scalable/apps/"

cat > "$DATA_DIR/applications/io.github.koukeneko.Nekoland.PaperEngine.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Paper Engine
Comment=Choose a live wallpaper from your Steam Wallpaper Engine library
Exec=gjs -m $APP_DIR/picker.js
Icon=nekoland-paper-engine
Categories=Utility;GTK;
Keywords=wallpaper;background;live;steam;
EOF

# Nekoland keeps the setting it is given in its file; without Nekoland running there is no one to ask.
if ! config="$(nekoland msg config 2>/dev/null)"; then
    echo "Installed. Nekoland is not running here: add \"$DAEMON\" to autostart in ~/.config/nekoland/config.toml."
    exit 0
fi
# The autostart list with the daemon added, as TOML (which JSON's arrays of strings are), or nothing if it is there.
autostart="$(python3 -c '
import json, sys, tomllib
autostart = tomllib.loads(sys.stdin.read()).get("autostart", [])
if sys.argv[1] not in autostart:
    print(json.dumps(autostart + [sys.argv[1]]))' "$DAEMON" <<<"$config")"
if [[ -n "$autostart" ]]; then
    reply="$(nekoland msg "set autostart = $autostart")"
    if [[ -n "$reply" ]]; then
        echo "Could not add the daemon to Nekoland's autostart: $reply" >&2
        exit 1
    fi
fi
# The daemon now running carries on with the old code until it is started again.
pkill -f "^$DAEMON" 2>/dev/null || true
setsid $DAEMON >/dev/null 2>&1 < /dev/null &
echo "Installed. Open “Paper Engine” from the launcher to pick a wallpaper."
