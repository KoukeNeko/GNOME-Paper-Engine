# GNOME Paper Engine

Use the wallpapers from your Steam copy of [Wallpaper Engine](https://store.steampowered.com/app/431960/Wallpaper_Engine/)
as live desktop backgrounds on Ubuntu / GNOME (Wayland).

It is a GNOME Shell extension with a wallpaper picker. It needs a Wallpaper
Engine licence on Steam — the wallpapers and the scene assets come from your
own Steam library; nothing is bundled here.

| Wallpaper type | Rendered by | Status |
| --- | --- | --- |
| Video | built-in renderer (WebKitGTK + GStreamer) | works out of the box |
| Web | built-in renderer (WebKitGTK) | works out of the box; user properties supported, audio-reactive data is not |
| Scene | [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) | needs `setup-scene-renderer.sh`; fidelity is whatever that project supports |
| Application | — | not supported (Windows executables) |

## Requirements

- Ubuntu with GNOME Shell 51 on Wayland (developed on Ubuntu 26.10).
- Steam, with Wallpaper Engine owned.

No extra packages are needed for video and web wallpapers.

## Install

### As a .deb package

Download the latest development build from the
[dev release](https://github.com/KoukeNeko/GNOME-Paper-Engine/releases/tag/dev),
or build it yourself with `./build-deb.sh` (it ends up in `dist/`), then:

```bash
sudo apt install ./gnome-paper-engine_*_all.deb
```

Log out and back in, then turn the extension on once:

```bash
gnome-extensions enable gnome-paper-engine@koukeneko.github.io
```

Open **Paper Engine** from the app grid. To remove it again:

```bash
sudo apt remove gnome-paper-engine
```

### From the source folder, without root

```bash
./install.sh
```

Log out and back in once (a running GNOME Shell only discovers new extensions
at login), then open **Paper Engine** from the app grid. A copy installed
this way takes precedence over the package, so use one or the other.

### Getting wallpapers

1. In Steam, enable *Settings → Compatibility → Enable Steam Play for all other
   titles*, then install Wallpaper Engine (it is a Windows application; it only
   has to be installed, not run).
2. Subscribe to wallpapers in the
   [Workshop](https://steamcommunity.com/app/431960/workshop/). Steam downloads
   them to `steamapps/workshop/content/431960`, which the picker scans, along
   with the projects that ship with Wallpaper Engine.

You can also add your own folders of wallpaper projects under
*Settings → Extra wallpaper folders*.

### Scene wallpapers

```bash
gnome-paper-engine-setup-scene   # installed from the .deb
./setup-scene-renderer.sh            # from the source folder
```

This builds linux-wallpaperengine into `~/.local/share/gnome-paper-engine`
without root: its ~100 build dependencies are downloaded and unpacked there
rather than installed, because installing them system-wide would swap out
JACK libraries that Steam uses. It downloads roughly 1 GB and takes a few
minutes. Re-run it after a distribution upgrade; delete the directory to
remove it.

`patches/` holds fixes this project applies on top of linux-wallpaperengine so
puppet-warp layers (animated characters) are drawn; they are shown in their
rest pose, since that renderer does not play bone animations.

Scenes that use a 3D perspective camera (a few of the samples bundled with
Wallpaper Engine, e.g. *Neon Sunset*) are not supported by
linux-wallpaperengine yet; the extension reports that the renderer keeps
crashing and stops retrying.

## Using it

The picker has three panes (its interface is in Traditional Chinese):

- **Sidebar** – your library by type, the Steam Workshop (trending, newest,
  most subscribed, and what you are subscribed to), playback settings, and the
  wallpaper that is playing with pause / mute / stop.
- **Grid** – click a wallpaper to see its details, double-click to apply it.
- **Details** – preview, the apply button, and the options the wallpaper
  exposes (colours, sliders, toggles, …).

Workshop browsing reads Steam's public Workshop page, which is not a stable
interface and may break when Steam changes it. Subscribing happens in Steam:
the picker opens the wallpaper's page in the Steam client, and it appears in
the library once Steam has downloaded it.

By default playback pauses while every monitor is covered by a maximized or
fullscreen window. The same wallpaper is shown on every monitor. The wallpaper
is not shown on the lock screen or behind the Activities overview.

## How it works

`extension/extension.js` starts a renderer process and gives its windows the
`DESKTOP` window type, so Mutter keeps them below every other window, on all
workspaces, and out of the overview, dock and Alt-Tab — the same technique the
Desktop Icons extension uses, and the wallpaper sits below its icons.

- `extension/renderer.js` – GTK 3 + WebKitGTK process for video and web
  wallpapers, one window per monitor, controlled over stdin.
- `extension/library.js` – finds Steam libraries and reads `project.json`.
- `extension/prefs.js` – the picker and settings window.
- `extension/workshop.js` – reads the Steam Workshop browse page.

## Uninstall

The package: `sudo apt remove gnome-paper-engine`.

A source-folder install:

```bash
gnome-extensions disable gnome-paper-engine@koukeneko.github.io
rm -rf ~/.local/share/gnome-shell/extensions/gnome-paper-engine@koukeneko.github.io \
       ~/.local/share/applications/gnome-paper-engine.desktop
```

Either way the scene renderer stays in your home folder until you delete it:

```bash
rm -rf ~/.local/share/gnome-paper-engine ~/.cache/gnome-paper-engine
```

## Licence

GPL-3.0-or-later. Not affiliated with Wallpaper Engine or Valve.
