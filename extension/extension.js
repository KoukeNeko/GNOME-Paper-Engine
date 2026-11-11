// SPDX-License-Identifier: GPL-3.0-or-later
//
// Runs a wallpaper renderer process and turns its windows into desktop-layer
// windows, one per monitor, sitting below everything else (including the
// Desktop Icons window). The window-type approach follows the Desktop Icons NG
// extension that ships with Ubuntu.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadProject, resolveProperties, findSceneRenderer, findAssetsDir} from './library.js';

// Must match TITLE_PREFIX in renderer.js.
const RENDERER_TITLE_PREFIX = 'gnome-wallpaper-engine-renderer-';

const RELAUNCH_DELAY_MS = 2000;
// Stop relaunching a renderer that keeps dying, so a broken wallpaper can't
// turn into a crash loop.
const MAX_CONSECUTIVE_FAILURES = 5;
// A renderer that survived this long is considered healthy again.
const HEALTHY_RUNTIME_MS = 30000;
const PAUSE_CHECK_DELAY_MS = 250;
// How often the pointer position is forwarded to the wallpaper (for parallax and hover effects).
const POINTER_INTERVAL_MS = 33;

const SCENE_SCALING = {cover: 'fill', contain: 'fit', fill: 'stretch'};

const SIGSTOP = 19;
const SIGCONT = 18;

export default class WallpaperEngineExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // {subprocess, pid, stdin, builtin, monitorIndex, startTime}. Only the
        // built-in renderer understands commands; the scene renderer reads
        // nothing but pointer positions from its stdin.
        this._renderers = [];
        this._pointerId = 0;
        this._lastPointer = '';
        // Meta.Window → {monitorIndex, signalIds}
        this._adoptedWindows = new Map();
        this._failures = 0;
        this._paused = false;
        this._relaunchId = 0;
        this._pauseCheckId = 0;
        this._signals = [];

        const connect = (object, signal, callback) =>
            this._signals.push([object, object.connect(signal, callback)]);

        connect(this._settings, 'changed', (_settings, key) => this._onSettingChanged(key));
        connect(Main.layoutManager, 'monitors-changed', () => this._launch());
        connect(global.display, 'window-created', (_display, window) => this._adoptWindow(window));
        this._signals.push([global.window_manager, global.window_manager.connect_after(
            'map', (_wm, actor) => this._placeWindow(actor.meta_window))]);
        connect(global.display, 'notify::focus-window', () => this._passOnFocus());

        for (const signal of ['size-changed', 'minimize', 'unminimize', 'map', 'destroy', 'switch-workspace'])
            connect(global.window_manager, signal, () => this._queuePauseCheck());
        connect(global.display, 'restacked', () => this._queuePauseCheck());

        if (Main.layoutManager._startingUp)
            connect(Main.layoutManager, 'startup-complete', () => this._launch());
        else
            this._launch();
    }

    disable() {
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = null;
        if (this._relaunchId)
            GLib.source_remove(this._relaunchId);
        if (this._pauseCheckId)
            GLib.source_remove(this._pauseCheckId);
        if (this._pointerId)
            GLib.source_remove(this._pointerId);
        this._pointerId = 0;
        this._relaunchId = 0;
        this._pauseCheckId = 0;
        this._stop();
        this._settings = null;
    }

    _onSettingChanged(key) {
        const commandable = this._renderers.every(renderer => renderer.builtin);
        if (key === 'muted' && commandable) {
            this._sendCommand(`mute ${this._settings.get_boolean('muted') ? 1 : 0}`);
        } else if (key === 'volume' && commandable) {
            this._sendCommand(`volume ${this._settings.get_int('volume')}`);
        } else if (key === 'pause-mode' || key === 'paused') {
            this._queuePauseCheck();
        } else if (key !== 'extra-dirs') {
            this._failures = 0;
            this._launch();
        }
    }

    _launch() {
        this._stop();
        if (this._relaunchId) {
            GLib.source_remove(this._relaunchId);
            this._relaunchId = 0;
        }

        // A manual pause belongs to the wallpaper that was playing; a renderer
        // that starts out paused would never get to show its first frame.
        if (this._settings.get_boolean('paused'))
            this._settings.set_boolean('paused', false);

        const dir = this._settings.get_string('wallpaper');
        if (!dir)
            return;
        const project = loadProject(dir);
        if (!project) {
            this._notify(`No wallpaper project found in ${dir}`);
            return;
        }

        let overrides = {};
        try {
            overrides = JSON.parse(this._settings.get_string('user-properties'))[dir] ?? {};
        } catch (e) {
            console.warn(`${this.uuid}: ignoring malformed user-properties: ${e.message}`);
        }
        const properties = resolveProperties(project, overrides);

        try {
            if (project.type === 'video' || project.type === 'web')
                this._spawnBuiltinRenderer(project, properties);
            else if (project.type === 'scene')
                this._spawnSceneRenderers(project, properties);
            else
                this._notify(`“${project.title}” is a “${project.type}” wallpaper, which is not supported`);
        } catch (e) {
            console.error(e);
            this._notify(`Could not start the wallpaper renderer: ${e.message}`);
        }
        this._queuePauseCheck();
        if (this._renderers.length > 0 && !this._pointerId) {
            this._pointerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, POINTER_INTERVAL_MS, () => {
                this._forwardPointer();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    _spawnBuiltinRenderer(project, properties) {
        const argv = [
            'gjs', '-m', GLib.build_filenamev([this.path, 'renderer.js']),
            '--type', project.type,
            '--file', project.file,
            '--fit', this._settings.get_string('fit'),
            '--volume', `${this._settings.get_int('volume')}`,
            '--monitors', `${Main.layoutManager.monitors.length}`,
            // Wallpaper Engine hands pages their properties as {name: {value}}.
            '--properties', JSON.stringify(Object.fromEntries(
                Object.entries(properties).map(([name, value]) => [name, {value}]))),
        ];
        if (this._settings.get_boolean('muted'))
            argv.push('--muted');
        this._spawn(argv, Gio.SubprocessFlags.STDIN_PIPE, true, null);
    }

    // linux-wallpaperengine opens a single window, so run one per monitor.
    _spawnSceneRenderers(project, properties) {
        const binary = findSceneRenderer(this._settings.get_string('scene-renderer'));
        if (!binary) {
            this._notify('Scene wallpapers need linux-wallpaperengine. Run setup-scene-renderer.sh from the project folder to install it.');
            return;
        }
        const assetsDir = findAssetsDir();
        if (!assetsDir) {
            this._notify('Scene wallpapers need Wallpaper Engine itself to be installed in Steam (for its assets folder).');
            return;
        }

        for (const monitor of Main.layoutManager.monitors) {
            const argv = [
                binary,
                '--assets-dir', assetsDir,
                // Window sizes are in logical pixels, like the monitor geometry.
                '--window', `0x0x${monitor.width}x${monitor.height}`,
                '--scaling', SCENE_SCALING[this._settings.get_string('fit')],
                '--volume', `${this._settings.get_int('volume')}`,
                // Pausing is driven by this extension instead.
                '--no-fullscreen-pause',
            ];
            if (this._settings.get_boolean('muted'))
                argv.push('--silent');
            for (const [name, value] of Object.entries(properties))
                argv.push('--set-property', `${name}=${value}`);
            argv.push(project.dir);
            this._spawn(argv, Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_SILENCE, false, monitor.index);
        }
    }

    _spawn(argv, flags, builtin, monitorIndex) {
        const subprocess = Gio.Subprocess.new(argv, flags);
        const renderer = {
            subprocess,
            pid: Number(subprocess.get_identifier()),
            stdin: subprocess.get_stdin_pipe(),
            builtin,
            monitorIndex,
            startTime: GLib.get_monotonic_time(),
        };
        this._renderers.push(renderer);

        subprocess.wait_async(null, () => {
            // Renderers we stopped ourselves were removed from the list first.
            if (!this._renderers.includes(renderer))
                return;
            const runtimeMs = (GLib.get_monotonic_time() - renderer.startTime) / 1000;
            this._failures = runtimeMs > HEALTHY_RUNTIME_MS ? 1 : this._failures + 1;
            this._stop();
            if (this._failures >= MAX_CONSECUTIVE_FAILURES) {
                this._notify('The wallpaper renderer keeps crashing; giving up on this wallpaper.');
                return;
            }
            console.warn(`${this.uuid}: renderer exited unexpectedly, relaunching`);
            this._relaunchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELAUNCH_DELAY_MS, () => {
                this._relaunchId = 0;
                this._launch();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _stop() {
        for (const [window, {signalIds}] of this._adoptedWindows)
            signalIds.forEach(id => window.disconnect(id));
        this._adoptedWindows.clear();

        if (this._pointerId) {
            GLib.source_remove(this._pointerId);
            this._pointerId = 0;
        }
        const renderers = this._renderers;
        this._renderers = [];
        this._paused = false;
        // SIGKILL also ends a renderer that is currently SIGSTOPped.
        for (const {subprocess} of renderers)
            subprocess.force_exit();
    }

    // Called as soon as a window exists, so it never shows up as a normal
    // window in the overview, dock or Alt-Tab.
    _adoptWindow(window) {
        if (this._adoptedWindows.has(window))
            return;
        const renderer = this._renderers.find(({pid}) => pid === window.get_pid());
        if (!renderer)
            return;

        let monitorIndex = renderer.monitorIndex;
        if (monitorIndex === null) {
            // The built-in renderer numbers its windows through their titles.
            const title = window.title ?? '';
            if (!title.startsWith(RENDERER_TITLE_PREFIX))
                return;
            monitorIndex = Number(title.slice(RENDERER_TITLE_PREFIX.length));
        }

        window.set_type(Meta.WindowType.DESKTOP);
        this._adoptedWindows.set(window, {
            monitorIndex,
            signalIds: [
                window.connect('raised', () => window.lower()),
                window.connect('unmanaged', () => this._adoptedWindows.delete(window)),
            ],
        });
    }

    // Geometry can only be imposed once the window is mapped.
    _placeWindow(window) {
        // Covers windows whose title was not known yet on creation.
        this._adoptWindow(window);
        const monitor = Main.layoutManager.monitors[this._adoptedWindows.get(window)?.monitorIndex];
        if (!monitor)
            return;
        window.move_resize_frame(false, monitor.x, monitor.y, monitor.width, monitor.height);
        window.lower();
    }

    // Mutter focuses newly mapped windows, and a wallpaper has no use for the
    // keyboard: hand focus back to the window the user is working in.
    _passOnFocus() {
        if (!this._adoptedWindows.has(global.display.focus_window))
            return;
        const workspace = global.workspace_manager.get_active_workspace();
        const [topWindow] = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, workspace);
        topWindow?.activate(global.get_current_time());
    }

    _queuePauseCheck() {
        if (this._pauseCheckId)
            return;
        this._pauseCheckId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PAUSE_CHECK_DELAY_MS, () => {
            this._pauseCheckId = 0;
            this._setPaused(this._settings.get_boolean('paused') || this._isDesktopCovered());
            return GLib.SOURCE_REMOVE;
        });
    }

    // True when, on every monitor, a fullscreen (or maximized) window hides the wallpaper.
    _isDesktopCovered() {
        const mode = this._settings.get_string('pause-mode');
        if (mode === 'never')
            return false;
        const workspace = global.workspace_manager.get_active_workspace();
        const coveringWindows = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window =>
                window.window_type === Meta.WindowType.NORMAL &&
                !window.minimized &&
                window.located_on_workspace(workspace) &&
                (window.fullscreen || (mode === 'maximized' && window.is_maximized())));
        return Main.layoutManager.monitors.every(
            monitor => coveringWindows.some(window => window.get_monitor() === monitor.index));
    }

    _setPaused(paused) {
        if (paused === this._paused || this._renderers.length === 0)
            return;
        this._paused = paused;
        this._sendCommand(paused ? 'pause' : 'play');
        for (const {subprocess, builtin} of this._renderers) {
            if (!builtin)
                subprocess.send_signal(paused ? SIGSTOP : SIGCONT);
        }
    }

    _sendCommand(command) {
        for (const renderer of this._renderers) {
            if (renderer.builtin)
                this._write(renderer, command);
        }
    }

    _write(renderer, line) {
        try {
            renderer.stdin.write_all(`${line}\n`, null);
        } catch (e) {
            // The renderer just died; its exit handler deals with that.
            console.warn(`${this.uuid}: could not write to the renderer: ${e.message}`);
        }
    }

    // Wallpaper windows sit below everything and never get pointer events, so
    // tell the renderer where the pointer is, as fractions of its monitor.
    _forwardPointer() {
        if (this._paused)
            return;
        const [x, y] = global.get_pointer();
        const monitor = Main.layoutManager.monitors.find(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        if (!monitor)
            return;
        const position = `${((x - monitor.x) / monitor.width).toFixed(4)} ${((y - monitor.y) / monitor.height).toFixed(4)}`;
        const pointer = `${monitor.index} ${position}`;
        if (pointer === this._lastPointer)
            return;
        this._lastPointer = pointer;
        for (const renderer of this._renderers) {
            // Dropping an update is fine, blocking the compositor on a
            // renderer that stopped reading is not.
            if (renderer.stdin.has_pending())
                continue;
            let line;
            if (renderer.builtin)
                line = `mouse ${pointer}`;
            else if (renderer.monitorIndex === monitor.index)
                line = position;
            else
                continue;
            renderer.stdin.write_bytes_async(
                new TextEncoder().encode(`${line}\n`), GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                    try {
                        stream.write_bytes_finish(result);
                    } catch (e) {
                        // The renderer went away; its exit handler deals with that.
                    }
                });
        }
    }

    _notify(message) {
        console.warn(`${this.uuid}: ${message}`);
        Main.notify('Wallpaper Engine', message);
    }
}
