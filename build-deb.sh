#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Builds dist/gnome-wallpaper-engine_<version>_all.deb.
#
#   Install:    sudo apt install ./dist/gnome-wallpaper-engine_<version>_all.deb
#   Uninstall:  sudo apt remove gnome-wallpaper-engine
#
# The package installs the extension system-wide; each user still turns it on
# once with `gnome-extensions enable gnome-wallpaper-engine@doeshing` after
# logging in again. The scene renderer is not part of the package: it is built
# per user by `gnome-wallpaper-engine-setup-scene`.

set -euo pipefail
# Package files must not be group-writable, whatever the caller's umask is.
umask 022

PACKAGE=gnome-wallpaper-engine
UUID=gnome-wallpaper-engine@doeshing
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for tool in dpkg-deb glib-compile-schemas python3; do
    command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

# metadata.json is the single place the version and supported shell are written down.
read_metadata() {
    python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' \
        "$SOURCE_DIR/extension/metadata.json" "$1"
}
# CI appends a suffix such as ~dev42 for development builds.
VERSION="$(read_metadata version-name)${DEB_VERSION_SUFFIX:-}"
SHELL_VERSION="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["shell-version"][0])' \
    "$SOURCE_DIR/extension/metadata.json")"
MAINTAINER="${DEB_MAINTAINER:-$(git -C "$SOURCE_DIR" config user.name) <$(git -C "$SOURCE_DIR" config user.email)>}"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
ROOT="$STAGING/root"

extension_dir="$ROOT/usr/share/gnome-shell/extensions/$UUID"
data_dir="$ROOT/usr/share/$PACKAGE"
doc_dir="$ROOT/usr/share/doc/$PACKAGE"
mkdir -p "$extension_dir/schemas" "$data_dir/patches" "$doc_dir" \
    "$ROOT/usr/share/applications" "$ROOT/usr/bin" "$ROOT/DEBIAN"

install -m 644 "$SOURCE_DIR"/extension/*.js "$SOURCE_DIR/extension/metadata.json" "$extension_dir"
install -m 644 "$SOURCE_DIR"/extension/schemas/*.gschema.xml "$extension_dir/schemas"
glib-compile-schemas --strict "$extension_dir/schemas"

install -m 755 "$SOURCE_DIR/setup-scene-renderer.sh" "$data_dir"
install -m 644 "$SOURCE_DIR"/patches/*.patch "$data_dir/patches"
ln -s "../share/$PACKAGE/setup-scene-renderer.sh" "$ROOT/usr/bin/$PACKAGE-setup-scene"

install -m 644 "$SOURCE_DIR/README.md" "$doc_dir"
cat > "$doc_dir/copyright" <<EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: $PACKAGE

Files: *
Copyright: $(date +%Y) $MAINTAINER
License: GPL-3+
 On Debian systems, the full text of the GNU General Public License version 3
 can be found in /usr/share/common-licenses/GPL-3.
EOF

cat > "$ROOT/usr/share/applications/$PACKAGE.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Wallpaper Engine
Comment=Choose a live wallpaper from your Steam Wallpaper Engine library
Exec=gnome-extensions prefs $UUID
Icon=preferences-desktop-wallpaper
Categories=Utility;GNOME;GTK;
Keywords=wallpaper;background;live;steam;
EOF

installed_size="$(du -sk --exclude=DEBIAN "$ROOT" | cut -f1)"
cat > "$ROOT/DEBIAN/control" <<EOF
Package: $PACKAGE
Version: $VERSION
Architecture: all
Maintainer: $MAINTAINER
Installed-Size: $installed_size
Section: gnome
Priority: optional
Depends: gnome-shell (>= $SHELL_VERSION), gnome-shell (<< $((SHELL_VERSION + 1))), gjs,
 gir1.2-gtk-3.0, gir1.2-webkit2-4.1, gir1.2-gtk-4.0, gir1.2-adw-1,
 gir1.2-soup-3.0, gir1.2-gdkpixbuf-2.0,
 gstreamer1.0-plugins-good, gstreamer1.0-libav
Recommends: git, cmake, ninja-build, g++
Description: Steam Wallpaper Engine wallpapers as live GNOME backgrounds
 A GNOME Shell extension that shows the wallpapers from your Steam copy of
 Wallpaper Engine as live desktop backgrounds, with a picker that also browses
 the Steam Workshop.
 .
 Video and web wallpapers work out of the box. Scene wallpapers need a renderer
 that each user builds once by running $PACKAGE-setup-scene (which is
 what the recommended packages are for).
EOF

# A copy installed with install.sh would shadow the packaged extension.
cat > "$ROOT/DEBIAN/postinst" <<EOF
#!/bin/sh
set -e
if [ "\$1" = configure ]; then
    echo "$PACKAGE: log out and back in, then run:"
    echo "    gnome-extensions enable $UUID"
    echo "$PACKAGE: remove any copy in ~/.local/share/gnome-shell/extensions/$UUID first;"
    echo "    it would take precedence over this package."
fi
EOF
chmod 755 "$ROOT/DEBIAN/postinst"

mkdir -p "$SOURCE_DIR/dist"
output="$SOURCE_DIR/dist/${PACKAGE}_${VERSION}_all.deb"
dpkg-deb --root-owner-group --build "$ROOT" "$output" >/dev/null
echo "Built $output"
