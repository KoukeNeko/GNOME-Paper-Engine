#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Builds linux-wallpaperengine (https://github.com/Almamu/linux-wallpaperengine),
# the renderer this project uses for "scene" wallpapers, without root.
#
# Its build dependencies are downloaded with apt and unpacked into a private
# directory instead of being installed: installing them system-wide would
# replace libjack-jackd2 (including the i386 build Steam uses) with libjack0.
#
# Everything ends up under ~/.local/share/gnome-paper-engine; delete that
# directory to uninstall. Re-run this script after a distribution upgrade.

set -euo pipefail

LWE_REPOSITORY=https://github.com/Almamu/linux-wallpaperengine.git
LWE_COMMIT=a0ddce586e9ff12e9d31ca6b103f6036cc1b68fe

BUILD_DEPENDENCIES=(
    libglew-dev libglut-dev libsdl2-dev liblz4-dev libglm-dev libglfw3-dev
    libavcodec-dev libavformat-dev libavutil-dev libswscale-dev libswresample-dev
    libmpv-dev libpulse-dev libfftw3-dev libdbus-1-dev libxxf86vm-dev
)

# Resolved through symlinks: the .deb installs this script as a link in /usr/bin.
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-paper-engine"
BUILD_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/gnome-paper-engine"
SYSROOT="$PREFIX/sysroot"
MULTIARCH="$(gcc -print-multiarch)"
SYSROOT_LIBDIR="$SYSROOT/usr/lib/$MULTIARCH"

for tool in git cmake ninja g++ apt-get dpkg; do
    command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done

echo "==> Downloading build dependencies (nothing is installed system-wide)"
# Packages from an earlier run (an older release, perhaps) must not be unpacked with the new ones.
rm -rf "$BUILD_DIR/debs"
mkdir -p "$BUILD_DIR/debs/partial"
apt-get install --yes --download-only --no-install-recommends \
    -o Debug::NoLocking=true -o Dir::Cache::archives="$BUILD_DIR/debs" \
    "${BUILD_DEPENDENCIES[@]}"

echo "==> Unpacking them into $SYSROOT"
rm -rf "$SYSROOT"
mkdir -p "$SYSROOT"
for deb in "$BUILD_DIR"/debs/*.deb; do
    dpkg -x "$deb" "$SYSROOT"
done
# The -dev packages expect the runtime libraries next to them, but libraries
# that were already installed live in the system directory: link those in.
for library in /usr/lib/"$MULTIARCH"/lib*.so*; do
    if [ ! -e "$SYSROOT_LIBDIR/$(basename "$library")" ]; then
        ln -sf "$library" "$SYSROOT_LIBDIR/"
    fi
done
# Make the unpacked pkg-config files point into the private directory.
find "$SYSROOT/usr" -name '*.pc' -exec \
    sed -i -E "s|=/usr(/\|\$)|=$SYSROOT/usr\\1|" {} +

echo "==> Fetching linux-wallpaperengine"
SOURCE_DIR="$BUILD_DIR/linux-wallpaperengine"
if [ ! -d "$SOURCE_DIR/.git" ]; then
    git clone "$LWE_REPOSITORY" "$SOURCE_DIR"
fi
git -C "$SOURCE_DIR" fetch origin
git -C "$SOURCE_DIR" checkout --force --detach "$LWE_COMMIT"
git -C "$SOURCE_DIR" submodule update --init --recursive
# Fixes: puppet-warp layers (animated characters), pointer position from the extension, parallax smoothing.
git -C "$SOURCE_DIR" apply "$SCRIPT_DIR"/patches/*.patch

echo "==> Building (this downloads the Chromium Embedded Framework and takes a while)"
INCLUDE_FLAGS="-isystem $SYSROOT/usr/include -isystem $SYSROOT/usr/include/$MULTIARCH"
export CFLAGS="$INCLUDE_FLAGS" CXXFLAGS="$INCLUDE_FLAGS"
export LDFLAGS="-L$SYSROOT_LIBDIR -Wl,-rpath-link,$SYSROOT_LIBDIR"
export CMAKE_PREFIX_PATH="$SYSROOT/usr"
export PKG_CONFIG_PATH="$SYSROOT_LIBDIR/pkgconfig:$SYSROOT/usr/share/pkgconfig"
export LD_LIBRARY_PATH="$SYSROOT_LIBDIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

cmake --fresh -S "$SOURCE_DIR" -B "$SOURCE_DIR/build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX/linux-wallpaperengine"
cmake --build "$SOURCE_DIR/build"
rm -rf "$PREFIX/linux-wallpaperengine"
cmake --install "$SOURCE_DIR/build"
# The picker compares this with the patches it ships to tell when the renderer needs rebuilding.
cat "$SCRIPT_DIR"/patches/*.patch | sha256sum | cut -d' ' -f1 > "$PREFIX/linux-wallpaperengine/patches.sha256"

# The extension looks for this launcher; it points the binary at the private libraries.
mkdir -p "$PREFIX/bin"
cat > "$PREFIX/bin/linux-wallpaperengine" <<EOF
#!/bin/sh
export LD_LIBRARY_PATH="$SYSROOT_LIBDIR\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "$PREFIX/linux-wallpaperengine/linux-wallpaperengine" "\$@"
EOF
chmod +x "$PREFIX/bin/linux-wallpaperengine"

"$PREFIX/bin/linux-wallpaperengine" --help >/dev/null
echo "==> Done. Scene wallpapers are now available in the Paper Engine picker."
