# GNOME Paper Engine

Use the wallpapers from your Steam copy of [Wallpaper Engine](https://store.steampowered.com/app/431960/Wallpaper_Engine/)
as live desktop backgrounds on Ubuntu / GNOME (Wayland).

It is a GNOME Shell extension with a wallpaper picker. It needs a Wallpaper
Engine licence on Steam — the wallpapers and the scene assets come from your
own Steam library; nothing is bundled here.

![A scene wallpaper as the desktop background](docs/desktop.jpg)

![The picker: library and Workshop on the left, wallpapers in the middle, details and options on the right](docs/picker.jpg)

![The overview with windows on several workspaces, each showing the wallpaper](docs/workspaces.jpg)

| The overview and its workspace thumbnails show the wallpaper | A scene's media display, fed by the player that is running |
| --- | --- |
| ![Activities overview with the live wallpaper behind it](docs/overview.jpg) | ![A billboard in a scene showing the song, artist, position and cover](docs/media-display.png) |

| Wallpaper type | Rendered by | Status |
| --- | --- | --- |
| Video | built-in renderer (WebKitGTK + GStreamer) | works out of the box |
| Web | built-in renderer (WebKitGTK) | works out of the box; user properties and audio-reactive data supported |
| Scene | [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine), patched | needs the one-time setup below; most 2D scenes work, with scripts, text, clicks and media displays |
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

Scene wallpapers need a renderer that is built once per user. The picker
offers to do it: press **Install** on the bar that appears above the
wallpapers. The same can be done from a terminal:

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
puppet-warp layers (animated characters) are drawn, scene scripts run, and
text layers and media displays work; characters are shown in their rest pose,
since that renderer does not play bone animations.

Scenes that use a 3D perspective camera (a few of the samples bundled with
Wallpaper Engine, e.g. *Neon Sunset*) are not supported by
linux-wallpaperengine yet; the extension reports that the renderer keeps
crashing and stops retrying.

## Using it

The picker has three panes. It is available in English and Traditional
Chinese; it follows the system language unless you pick one under
*Playback and performance → Language*.

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
fullscreen window. With several monitors, a wallpaper can be applied to all
of them or to one. Wallpapers added to the playlist can rotate on a timer
(*Playback and performance → Playlist*).

A still of the wallpaper is set as the system's desktop background, so that
is what shows before the wallpaper starts and in anything that reads the
background; the previous background comes back when the wallpaper is stopped
(*Playback and performance → Still image as desktop background*).

Scene wallpapers with a media display show what is playing in any MPRIS
player (title, artist, position, and the cover when the player hands it over
as a local file).

With [Blur my Shell](https://github.com/aunetx/blur-my-shell) installed, its
blur of the Dock and the top bar can be switched between the wallpaper alone
and everything behind them from the same settings page.

Web wallpapers are Workshop content, so each one is confined to the files of
its own folder; it cannot read anything else on the computer.

Web wallpapers that visualise audio get the spectrum of whatever the system
is playing; it is only captured while such a wallpaper is running.

The wallpaper never receives input itself, so the extension forwards the
pointer position and left clicks that start on the desktop; wallpapers react
to those as far as their renderer supports it. Behind the lock screen the
wallpaper keeps playing, slightly dimmed (this can be turned off). It is also
the background of the workspaces and their thumbnails in the Activities
overview, and it replaces the system background wherever the shell or an
extension such as Blur my Shell draws a copy of it.

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
- `extension/conditions.js` – evaluates when a wallpaper option is shown.
- `extension/backgroundClones.js` – the wallpaper in the overview, its
  thumbnails and wherever else a copy of the system background is drawn.
- `extension/roundedClip.js` – the rounded clip of the wallpaper in the overview.
- `tests/run.js` – tests for the parsers that read outside content
  (`gjs -m tests/run.js`).
- `po/` – translations; `zh_TW.po` is the only one so far.

## Uninstall

The package: `sudo apt remove gnome-paper-engine`.

A source-folder install:

```bash
gnome-extensions disable gnome-paper-engine@koukeneko.github.io
rm -rf ~/.local/share/gnome-shell/extensions/gnome-paper-engine@koukeneko.github.io \
       ~/.local/share/applications/gnome-paper-engine.desktop
```

Either way the scene renderer stays in your home folder until you delete it.
The still image used as the desktop background is kept there too, so turn
that option off (or pick another background) first:

```bash
rm -rf ~/.local/share/gnome-paper-engine ~/.cache/gnome-paper-engine
```

## Licence

GPL-3.0-or-later. Not affiliated with Wallpaper Engine or Valve.
