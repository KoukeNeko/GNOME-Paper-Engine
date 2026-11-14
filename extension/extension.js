// SPDX-License-Identifier: GPL-3.0-or-later
//
// Runs a wallpaper renderer process and turns its windows into desktop-layer
// windows, one per monitor, sitting below everything else (including the
// Desktop Icons window). The window-type approach follows the Desktop Icons NG
// extension that ships with Ubuntu.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    loadProject, resolveProperties, findSceneRenderer, findAssetsDir, format, blurMyShellSettings,
    BLUR_MY_SHELL_COMPONENTS,
} from './library.js';
import {BackgroundClones} from './backgroundClones.js';

// Must match TITLE_PREFIX in renderer.js.
const RENDERER_TITLE_PREFIX = 'gnome-paper-engine-renderer-';
// Must match the window title set in prefs.js.
const PICKER_TITLE = 'Paper Engine';

const RELAUNCH_DELAY_MS = 2000;
// A volume being stepped up or down restarts a scene once, not at every step.
const VOLUME_RELAUNCH_DELAY_MS = 400;
// Stop relaunching a renderer that keeps dying, so a broken wallpaper can't
// turn into a crash loop.
const MAX_CONSECUTIVE_FAILURES = 5;
// A renderer that survived this long is considered healthy again.
const HEALTHY_RUNTIME_MS = 30000;
const PAUSE_CHECK_DELAY_MS = 250;
// How often the pointer position is forwarded to the wallpaper (for parallax and hover effects).
const POINTER_INTERVAL_MS = 33;
const LOCK_SCREEN_CHECK_MS = 500;
const LOCK_SCREEN_BRIGHTNESS = -0.2;
// How long a wallpaper gets to load before a still of it is taken.
const STILL_DELAY_MS = 5000;
const BACKGROUND_SCHEMA = 'org.gnome.desktop.background';
const BACKGROUND_KEYS = ['picture-uri', 'picture-uri-dark'];
const STILL_NAME = 'still.png';

// Settings that only take effect by restarting the renderer.
const RELAUNCH_KEYS = [
    'wallpaper', 'monitor-wallpapers', 'fit', 'scene-renderer', 'user-properties', 'fps', 'render-scale', 'particles',
];
// Settings that decide whether the wallpaper plays.
const PLAYBACK_KEYS = [
    'paused', 'pause-while-sharing', 'when-focused', 'when-maximized', 'when-fullscreen', 'when-audio', 'when-on-battery',
];
// The nicks of the PlaybackAction enum, weakest first: when several
// conditions hold, the strongest of their actions is taken.
const PLAYBACK_ACTIONS = ['keep', 'mute', 'pause', 'stop'];
// What the sound streams of the wallpaper's renderers are called: the
// built-in renderer's PROGRAM_NAME, and the scene renderer's binary.
const OWN_STREAM_NAMES = ['gnome-paper-engine-renderer', 'linux-wallpaperengine'];

const SCENE_SCALING = {cover: 'fill', contain: 'fit', fill: 'stretch'};

// How often per second the extension may redo something that keeps getting
// undone, before it concludes that something else is working against it.
const REPEAT_LIMIT = 10;
const REPEAT_WINDOW_MS = 1000;

const SIGSTOP = 19;
const SIGCONT = 18;

export default class PaperEngineExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // A single pause-mode setting came before the playback rules.
        const pauseMode = this._settings.get_user_value('pause-mode')?.unpack();
        if (pauseMode) {
            this._settings.set_string('when-maximized', pauseMode === 'maximized' ? 'pause' : 'keep');
            this._settings.set_string('when-fullscreen', pauseMode === 'never' ? 'keep' : 'pause');
            this._settings.reset('pause-mode');
        }
        // {subprocess, pid, stdin, builtin, monitorIndex, startTime}. Only the
        // built-in renderer understands commands; the scene renderer reads
        // nothing but pointer positions from its stdin.
        this._renderers = [];
        this._pointerId = 0;
        this._lastPointer = '';
        this._buttonWasDown = false;
        this._clicking = false;
        // Meta.Window → {monitorIndex, signalIds}
        this._adoptedWindows = new Map();
        // What the extension keeps redoing → {since, count} within the current second.
        this._repeats = new Map();
        this._failures = 0;
        this._paused = false;
        // Muted by a playback rule, on top of the user's own setting.
        this._muted = false;
        // Ended by a playback rule, to be started again when it no longer applies.
        this._stopped = false;
        this._relaunchId = 0;
        this._pauseCheckId = 0;
        this._lockScreenId = 0;
        this._rotationId = 0;
        this._stillId = 0;
        this._backgroundSettings = new Gio.Settings({schema_id: BACKGROUND_SCHEMA});
        this._lockScreenClones = new Set();
        this._signals = [];

        const connect = (object, signal, callback) =>
            this._signals.push([object, object.connect(signal, callback)]);

        connect(this._settings, 'changed', (_settings, key) => this._onSettingChanged(key));
        connect(Main.layoutManager, 'monitors-changed', () => this._launch());
        connect(Main.sessionMode, 'updated', () => this._onSessionModeChanged());
        connect(global.display, 'window-created', (_display, window) => this._adoptWindow(window));
        this._signals.push([global.window_manager, global.window_manager.connect_after(
            'map', (_wm, actor) => this._placeWindow(actor.meta_window))]);
        connect(global.display, 'notify::focus-window', () => {
            this._passOnFocus();
            this._queuePauseCheck();
        });

        for (const signal of ['size-changed', 'minimize', 'unminimize', 'map', 'destroy', 'switch-workspace'])
            connect(global.window_manager, signal, () => this._queuePauseCheck());
        connect(global.display, 'restacked', () => this._queuePauseCheck());
        for (const signal of ['showing', 'hidden'])
            connect(Main.overview, signal, () => this._queuePauseCheck());

        this._backgroundClones = new BackgroundClones(
            monitorIndex => this._wallpaperActor(monitorIndex), () => this._queuePauseCheck());
        // Screen shares and recordings that are running, for pause-while-sharing.
        this._screenShares = new Set();
        connect(global.backend.get_remote_access_controller(), 'new-handle', (_controller, handle) => {
            this._screenShares.add(handle);
            handle.connect('stopped', () => {
                this._screenShares.delete(handle);
                // A share can outlive the extension being disabled.
                if (this._settings)
                    this._queuePauseCheck();
            });
            this._queuePauseCheck();
        });

        // The shell's own mixer, which knows every application's sound streams.
        this._mixer = getMixerControl();
        for (const signal of ['stream-added', 'stream-removed', 'stream-changed'])
            connect(this._mixer, signal, () => this._queuePauseCheck());

        this._upower = null;
        this._upowerCancellable = new Gio.Cancellable();
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower',
            this._upowerCancellable, (_source, result) => {
                try {
                    this._upower = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`${this.uuid}: power source unknown, ignoring battery power: ${e.message}`);
                    return;
                }
                connect(this._upower, 'g-properties-changed', () => this._queuePauseCheck());
                this._queuePauseCheck();
            });

        this._applyBlurMyShellDefaults();
        this._scheduleRotation();
        if (Main.layoutManager._startingUp)
            connect(Main.layoutManager, 'startup-complete', () => this._launch());
        else
            this._launch();
    }

    // Blur my Shell blurs only the wallpaper behind the Dock and the top bar by
    // default; over a live wallpaper the windows behind them should show too.
    // Done once, whenever Blur my Shell is first seen, so a later choice stays.
    _applyBlurMyShellDefaults() {
        if (this._settings.get_boolean('blur-my-shell-defaults-applied'))
            return;
        const components = BLUR_MY_SHELL_COMPONENTS.map(blurMyShellSettings).filter(Boolean);
        if (components.length === 0)
            return;
        for (const blurSettings of components)
            blurSettings.set_boolean('static-blur', false);
        this._settings.set_boolean('blur-my-shell-defaults-applied', true);
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
        if (this._lockScreenId)
            GLib.source_remove(this._lockScreenId);
        if (this._rotationId)
            GLib.source_remove(this._rotationId);
        if (this._stillId)
            GLib.source_remove(this._stillId);
        this._stillId = 0;
        this._backgroundSettings = null;
        this._rotationId = 0;
        this._lockScreenId = 0;
        this._pointerId = 0;
        this._relaunchId = 0;
        this._pauseCheckId = 0;
        this._lockScreenClones.forEach(clone => clone.destroy());
        this._lockScreenClones.clear();
        this._backgroundClones.destroy();
        this._backgroundClones = null;
        this._upowerCancellable.cancel();
        this._upowerCancellable = null;
        this._upower = null;
        this._mixer = null;
        this._stop();
        this._settings = null;
    }

    _onSettingChanged(key) {
        const commandable = this._renderers.every(renderer => renderer.builtin);
        if (key === 'muted' && commandable) {
            this._sendMute();
        } else if (key === 'volume' && commandable) {
            this._sendCommand(`volume ${this._settings.get_int('volume')}`);
        } else if (key === 'show-on-lock-screen') {
            this._onSessionModeChanged();
        } else if (PLAYBACK_KEYS.includes(key)) {
            this._queuePauseCheck();
        } else if (key === 'rotation-interval') {
            this._scheduleRotation();
        } else if (key === 'system-background') {
            this._scheduleStill();
        } else if (key === 'muted' || key === 'volume') {
            this._failures = 0;
            if (this._relaunchId)
                GLib.source_remove(this._relaunchId);
            this._relaunchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, VOLUME_RELAUNCH_DELAY_MS, () => {
                this._relaunchId = 0;
                this._launch();
                return GLib.SOURCE_REMOVE;
            });
        } else if (RELAUNCH_KEYS.includes(key)) {
            this._failures = 0;
            this._launch();
        }
    }

    // (Re)starts the timer that moves on to the next playlist wallpaper.
    _scheduleRotation() {
        if (this._rotationId) {
            GLib.source_remove(this._rotationId);
            this._rotationId = 0;
        }
        const minutes = this._settings.get_int('rotation-interval');
        if (minutes === 0)
            return;
        this._rotationId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
            // Nobody sees the wallpaper while it is paused or stopped; wait for the next round.
            if (!this._paused && !this._stopped)
                this._showNextInPlaylist();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _showNextInPlaylist() {
        const playlist = this._settings.get_strv('playlist').filter(dir => loadProject(dir) !== null);
        const current = this._settings.get_string('wallpaper');
        const others = playlist.filter(dir => dir !== current);
        if (others.length === 0)
            return;
        const next = this._settings.get_boolean('rotation-shuffle')
            ? others[Math.floor(Math.random() * others.length)]
            // After the current one, wrapping around; the first if the current is not in the list.
            : playlist[(playlist.indexOf(current) + 1) % playlist.length];
        this._settings.set_string('wallpaper', next);
    }

    _launch() {
        this._stop();
        this._stopped = false;
        if (this._relaunchId) {
            GLib.source_remove(this._relaunchId);
            this._relaunchId = 0;
        }

        // A manual pause belongs to the wallpaper that was playing; a renderer
        // that starts out paused would never get to show its first frame.
        if (this._settings.get_boolean('paused'))
            this._settings.set_boolean('paused', false);

        for (const [dir, monitors] of this._wallpaperAssignments())
            this._launchProject(dir, monitors);

        this._queuePauseCheck();
        this._scheduleStill();
        if (this._renderers.length > 0 && !this._pointerId) {
            this._pointerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, POINTER_INTERVAL_MS, () => {
                this._forwardPointer();
                return GLib.SOURCE_CONTINUE;
            });
        }
    }

    // The desktop background of the system becomes a still of the wallpaper:
    // it is what shows before the wallpaper starts (at login, or should the
    // renderer fail) and what everything that reads the background gets.
    _scheduleStill() {
        if (this._stillId) {
            GLib.source_remove(this._stillId);
            this._stillId = 0;
        }
        if (this._renderers.length === 0 || !this._settings.get_boolean('system-background')) {
            this._restoreSystemBackground();
            return;
        }
        this._stillId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STILL_DELAY_MS, () => {
            this._stillId = 0;
            this._saveStill().catch(e => console.warn(`${this.uuid}: no still of the wallpaper: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _saveStill() {
        const actor = this._wallpaperActor(Main.layoutManager.primaryIndex);
        if (!actor)
            return;
        // The window's own picture, whatever is in front of it.
        const texture = actor.paint_to_content(null).get_texture();

        // Not in the cache: the desktop background points at this file for as
        // long as the option is on, also while the extension is not running.
        const directory = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-paper-engine']);
        GLib.mkdir_with_parents(directory, 0o755);
        // Written under another name first: the shell reloads the background
        // as soon as its file changes, and must not find half a picture.
        const partial = Gio.File.new_for_path(GLib.build_filenamev([directory, `${STILL_NAME}.part`]));
        const still = Gio.File.new_for_path(GLib.build_filenamev([directory, STILL_NAME]));
        const stream = partial.replace(null, false, Gio.FileCreateFlags.NONE, null);
        await new Promise((resolve, reject) => {
            Shell.Screenshot.composite_to_stream(texture, 0, 0, -1, -1, 1, null, 0, 0, 1, stream, (_source, result) => {
                try {
                    Shell.Screenshot.composite_to_stream_finish(result);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
        });
        stream.close(null);
        partial.move(still, Gio.FileCopyFlags.OVERWRITE, null, null);

        // Disabled, stopped or switched off while the picture was being written.
        if (!this._settings?.get_boolean('system-background') || this._renderers.length === 0)
            return;
        const uri = still.get_uri();
        const current = BACKGROUND_KEYS.map(key => this._backgroundSettings.get_string(key));
        if (this._settings.get_strv('previous-background').length === 0 && !current.includes(uri))
            this._settings.set_strv('previous-background', current);
        for (const key of BACKGROUND_KEYS)
            this._backgroundSettings.set_string(key, uri);
    }

    _restoreSystemBackground() {
        const previous = this._settings.get_strv('previous-background');
        if (previous.length !== BACKGROUND_KEYS.length)
            return;
        // A background the user picked in the meantime is theirs to keep.
        BACKGROUND_KEYS.forEach((key, index) => {
            if (this._backgroundSettings.get_string(key).endsWith(`/gnome-paper-engine/${STILL_NAME}`))
                this._backgroundSettings.set_string(key, previous[index]);
        });
        this._settings.set_strv('previous-background', []);
    }

    // Which wallpaper goes on which monitors: Map of project directory →
    // monitors. Monitors without an entry of their own in monitor-wallpapers
    // (keyed by connector name) get the default wallpaper.
    _wallpaperAssignments() {
        let perMonitor = {};
        try {
            perMonitor = JSON.parse(this._settings.get_string('monitor-wallpapers'));
        } catch (e) {
            console.warn(`${this.uuid}: ignoring malformed monitor-wallpapers: ${e.message}`);
        }
        const monitorManager = global.backend.get_monitor_manager();
        const directories = Main.layoutManager.monitors.map(() => this._settings.get_string('wallpaper'));
        for (const [connector, dir] of Object.entries(perMonitor)) {
            const index = monitorManager.get_monitor_for_connector(connector);
            if (index >= 0 && index < directories.length)
                directories[index] = dir;
        }

        const assignments = new Map();
        directories.forEach((dir, index) => {
            if (!dir)
                return;
            if (!assignments.has(dir))
                assignments.set(dir, []);
            assignments.get(dir).push(Main.layoutManager.monitors[index]);
        });
        return assignments;
    }

    _launchProject(dir, monitors) {
        const project = loadProject(dir);
        if (!project) {
            this._notify(format(_('No wallpaper project found in %s'), dir));
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
                this._spawnBuiltinRenderer(project, properties, monitors);
            else if (project.type === 'scene')
                this._spawnSceneRenderers(project, properties, monitors);
            else
                this._notify(format(_('“%s” is a “%s” wallpaper, which is not supported'), project.title, project.type));
        } catch (e) {
            console.error(e);
            this._notify(format(_('Could not start the wallpaper renderer: %s'), e.message));
        }
    }

    _spawnBuiltinRenderer(project, properties, monitors) {
        const argv = [
            'gjs', '-m', GLib.build_filenamev([this.path, 'renderer.js']),
            '--type', project.type,
            '--file', project.file,
            '--fit', this._settings.get_string('fit'),
            '--fps', `${this._settings.get_int('fps')}`,
            '--volume', `${this._settings.get_int('volume')}`,
            '--monitors', monitors.map(monitor => monitor.index).join(','),
            // Wallpaper Engine hands pages their properties as {name: {value}}.
            '--properties', JSON.stringify(Object.fromEntries(
                Object.entries(properties).map(([name, value]) => [name, {value}]))),
        ];
        if (this._settings.get_boolean('muted'))
            argv.push('--muted');
        this._spawn(argv, Gio.SubprocessFlags.STDIN_PIPE, true, null);
    }

    // linux-wallpaperengine opens a single window, so run one per monitor.
    _spawnSceneRenderers(project, properties, monitors) {
        const binary = findSceneRenderer(this._settings.get_string('scene-renderer'));
        if (!binary) {
            this._notify(_('Scene wallpapers need the scene renderer. Install it from the Paper Engine window.'));
            return;
        }
        const assetsDir = findAssetsDir();
        if (!assetsDir) {
            this._notify(_('Scene wallpapers need the scene assets. Download them from the Paper Engine window.'));
            return;
        }

        for (const monitor of monitors) {
            const argv = [
                binary,
                '--assets-dir', assetsDir,
                // Window sizes are in logical pixels, like the monitor geometry.
                '--window', `0x0x${monitor.width}x${monitor.height}`,
                '--scaling', SCENE_SCALING[this._settings.get_string('fit')],
                '--fps', `${this._settings.get_int('fps')}`,
                // Joined with = so that a renderer built before the option ignores it whole.
                `--render-scale=${this._settings.get_string('render-scale')}`,
                '--volume', `${this._settings.get_int('volume')}`,
                // Pausing is driven by this extension instead.
                '--no-fullscreen-pause',
                // Muting is the user's setting here. Left on, the renderer mutes itself
                // whenever any other stream exists, e.g. for as long as a voice chat runs.
                '--noautomute',
            ];
            if (this._settings.get_boolean('muted'))
                argv.push('--silent');
            if (!this._settings.get_boolean('particles'))
                argv.push('--disable-particles');
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
            // Lines waiting for the write under way to finish.
            queue: [],
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
                this._notify(_('The wallpaper renderer keeps crashing; giving up on this wallpaper.'));
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
        this._muted = false;
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
                window.connect('raised', () => {
                    if (this._mayRepeat('lowering the wallpaper window'))
                        window.lower();
                }),
                window.connect('size-changed', () => this._keepInPlace(window)),
                window.connect('position-changed', () => this._keepInPlace(window)),
                window.connect('unmanaged', () => this._adoptedWindows.delete(window)),
            ],
        });
    }

    // The extension puts things back the way it wants them: the wallpaper at
    // the bottom and on its monitor, the focus on a real window. If something
    // else keeps undoing that, doing it again at once makes the two flicker
    // against each other for ever. Past a few times a second it is left as it
    // is instead, and the log says what was being repeated.
    _mayRepeat(action) {
        const now = GLib.get_monotonic_time() / 1000;
        let record = this._repeats.get(action);
        if (!record || now - record.since > REPEAT_WINDOW_MS) {
            record = {since: now, count: 0};
            this._repeats.set(action, record);
        }
        record.count++;
        if (record.count === REPEAT_LIMIT + 1)
            console.warn(`${this.uuid}: ${action} more than ${REPEAT_LIMIT} times a second; leaving it be`);
        return record.count <= REPEAT_LIMIT;
    }

    // A wallpaper window that moved or changed size no longer covers its monitor.
    _keepInPlace(window) {
        const adopted = this._adoptedWindows.get(window);
        const monitor = Main.layoutManager.monitors[adopted?.monitorIndex];
        if (!monitor || !window.get_compositor_private()?.mapped)
            return;
        const frame = window.get_frame_rect();
        if (frame.x === monitor.x && frame.y === monitor.y &&
            frame.width === monitor.width && frame.height === monitor.height)
            return;
        if (!adopted.misplacementLogged) {
            adopted.misplacementLogged = true;
            console.warn(`${this.uuid}: the wallpaper window is at ${frame.width}x${frame.height}+${frame.x}+${frame.y}, ` +
                `its monitor at ${monitor.width}x${monitor.height}+${monitor.x}+${monitor.y}`);
        }
        if (this._mayRepeat('putting the wallpaper window back on its monitor'))
            window.move_resize_frame(false, monitor.x, monitor.y, monitor.width, monitor.height);
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
        this._backgroundClones.sync();
    }

    _wallpaperActor(monitorIndex) {
        const window = [...this._adoptedWindows.keys()].find(
            adopted => this._adoptedWindows.get(adopted).monitorIndex === monitorIndex);
        return window?.get_compositor_private() ?? null;
    }

    // Mutter focuses newly mapped windows, and a wallpaper has no use for the
    // keyboard: hand focus back to the window the user is working in.
    _passOnFocus() {
        if (!this._adoptedWindows.has(global.display.focus_window) || !this._mayRepeat('handing the focus back'))
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
            this._applyPlayback();
            return GLib.SOURCE_REMOVE;
        });
    }

    _applyPlayback() {
        const action = this._playbackAction();
        if (action === 'stop') {
            // Ending the renderers frees the memory they hold.
            if (this._renderers.length > 0 && this._mayRepeat('stopping and starting')) {
                this._stopped = true;
                this._stop();
            }
            return;
        }
        if (this._stopped) {
            // A stopped wallpaper stands still already.
            if (action !== 'pause' && this._mayRepeat('stopping and starting'))
                this._launch();
            return;
        }
        this._setPaused(action === 'pause');
        this._setMuted(action === 'mute');
    }

    // One of PLAYBACK_ACTIONS: the strongest action of the conditions that hold now.
    _playbackAction() {
        if (this._settings.get_boolean('paused'))
            return 'pause';
        // Behind the lock screen the windows of the session don't cover anything.
        if (Main.sessionMode.isLocked)
            return this._settings.get_boolean('show-on-lock-screen') ? 'keep' : 'pause';
        const actions = [];
        // Sharing the screen loads the compositor and the GPU; a still
        // wallpaper leaves them more room.
        if (this._screenShares.size > 0 && this._settings.get_boolean('pause-while-sharing'))
            actions.push('pause');
        if (this._upower?.get_cached_property('OnBattery')?.unpack())
            actions.push(this._settings.get_string('when-on-battery'));
        if (this._isOtherAudioPlaying())
            actions.push(this._settings.get_string('when-audio'));
        // The overview and the app grid show the wallpaper on their
        // workspaces, around or instead of the windows that cover it.
        if (!Main.overview.visible && !this._backgroundClones.isShown()) {
            if (this._isOtherAppFocused())
                actions.push(this._settings.get_string('when-focused'));
            if (this._isDesktopCovered(window => window.fullscreen))
                actions.push(this._settings.get_string('when-fullscreen'));
            if (this._isDesktopCovered(window => window.fullscreen || window.is_maximized()))
                actions.push(this._settings.get_string('when-maximized'));
        }
        return PLAYBACK_ACTIONS[Math.max(0, ...actions.map(action => PLAYBACK_ACTIONS.indexOf(action)))];
    }

    // The desktop itself (the wallpaper and the icons) and the picker don't count.
    _isOtherAppFocused() {
        const window = global.display.focus_window;
        return window !== null && window.window_type !== Meta.WindowType.DESKTOP && window.title !== PICKER_TITLE;
    }

    // PulseAudio doesn't tell whether a stream is silent, so an application
    // counts as playing for as long as it keeps a stream open: a voice chat
    // for the whole call.
    _isOtherAudioPlaying() {
        return this._mixer.get_sink_inputs().some(stream =>
            !stream.is_event_stream && !stream.is_muted && !OWN_STREAM_NAMES.includes(stream.name));
    }

    // The lock screen hides every window, so the wallpaper is shown there as
    // clones of its windows, placed over the lock screen's own backgrounds.
    // (Not inside them: their blur effect caches its input and would freeze
    // the wallpaper on its first frame.)
    _onSessionModeChanged() {
        this._queuePauseCheck();
        this._syncLockScreenClones();
    }

    _syncLockScreenClones() {
        if (this._lockScreenId) {
            GLib.source_remove(this._lockScreenId);
            this._lockScreenId = 0;
        }
        this._lockScreenClones.forEach(clone => clone.destroy());
        this._lockScreenClones.clear();
        if (!Main.sessionMode.isLocked || !this._settings.get_boolean('show-on-lock-screen'))
            return;

        // The lock screen builds its backgrounds some time after the session
        // mode changes, and rebuilds them when monitors change: keep checking
        // while locked that every wallpaper window has its clone in place.
        const ensureClones = () => {
            const backgroundGroup = Main.screenShield?._dialog?._backgroundGroup;
            for (const [window, {monitorIndex}] of this._adoptedWindows) {
                const monitor = Main.layoutManager.monitors[monitorIndex];
                const actor = window.get_compositor_private();
                if (!backgroundGroup || !monitor || !actor)
                    continue;
                if ([...this._lockScreenClones].some(clone => clone.source === actor && clone.get_parent() === backgroundGroup))
                    continue;
                const clone = new Clutter.Clone({
                    source: actor, x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height,
                });
                // Dimmed a little so the clock stays readable on bright wallpapers.
                const dim = new Clutter.BrightnessContrastEffect();
                dim.set_brightness(LOCK_SCREEN_BRIGHTNESS);
                clone.add_effect(dim);
                clone.connect('destroy', () => this._lockScreenClones.delete(clone));
                this._lockScreenClones.add(clone);
                backgroundGroup.add_child(clone);
            }
            return GLib.SOURCE_CONTINUE;
        };
        ensureClones();
        this._lockScreenId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOCK_SCREEN_CHECK_MS, ensureClones);
    }

    // True when, on every monitor, a window for which `covers` holds hides the wallpaper.
    _isDesktopCovered(covers) {
        const workspace = global.workspace_manager.get_active_workspace();
        const coveringWindows = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window =>
                window.window_type === Meta.WindowType.NORMAL &&
                !window.minimized &&
                window.located_on_workspace(workspace) &&
                covers(window));
        return Main.layoutManager.monitors.every(
            monitor => coveringWindows.some(window => window.get_monitor() === monitor.index));
    }

    _setPaused(paused) {
        if (paused === this._paused || this._renderers.length === 0 || !this._mayRepeat('pausing and resuming'))
            return;
        this._paused = paused;
        this._sendCommand(paused ? 'pause' : 'play');
        for (const {subprocess, builtin} of this._renderers) {
            if (!builtin)
                subprocess.send_signal(paused ? SIGSTOP : SIGCONT);
        }
    }

    _setMuted(muted) {
        if (muted === this._muted || this._renderers.length === 0)
            return;
        this._muted = muted;
        this._sendMute();
    }

    // Both renderers understand this line; one that runs muted by the user's
    // setting already gets no sound to unmute.
    _sendMute() {
        const muted = this._muted || this._settings.get_boolean('muted');
        for (const renderer of this._renderers)
            this._write(renderer, `mute ${muted ? 1 : 0}`);
    }

    _sendCommand(command) {
        for (const renderer of this._renderers) {
            if (renderer.builtin)
                this._write(renderer, command);
        }
    }

    // Never blocks: a renderer that stopped reading must not stall the
    // compositor. A stream takes one write at a time, so a line written while
    // another is under way follows it.
    _write(renderer, line) {
        renderer.queue.push(line);
        if (renderer.queue.length > 1)
            return;
        const writeNext = () => {
            renderer.stdin.write_bytes_async(
                new TextEncoder().encode(`${renderer.queue[0]}\n`), GLib.PRIORITY_DEFAULT, null, (stream, result) => {
                    try {
                        stream.write_bytes_finish(result);
                    } catch (e) {
                        // The renderer went away; its exit handler deals with that.
                        renderer.queue.length = 0;
                        return;
                    }
                    renderer.queue.shift();
                    if (renderer.queue.length > 0)
                        writeNext();
                });
        };
        writeNext();
    }

    // Wallpaper windows sit below everything and never get pointer events, so
    // tell the renderer where the pointer is, as fractions of its monitor.
    _forwardPointer() {
        if (this._paused)
            return;
        const [x, y, modifiers] = global.get_pointer();
        const monitor = Main.layoutManager.monitors.find(m =>
            x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        if (!monitor)
            return;

        // A press counts as a click on the wallpaper when it starts on the
        // desktop rather than on some window, and lasts until the release.
        const buttonDown = Boolean(modifiers & Clutter.ModifierType.BUTTON1_MASK);
        if (!buttonDown)
            this._clicking = false;
        else if (!this._buttonWasDown)
            this._clicking = this._isDesktopAt(x, y);
        this._buttonWasDown = buttonDown;

        const position = `${((x - monitor.x) / monitor.width).toFixed(4)} ${((y - monitor.y) / monitor.height).toFixed(4)} ${this._clicking ? 1 : 0}`;
        const pointer = `${monitor.index} ${position}`;
        if (pointer === this._lastPointer)
            return;
        // Kept only if every renderer got it, so a press or release that had
        // to be skipped below is sent again on the next tick.
        this._lastPointer = pointer;
        for (const renderer of this._renderers) {
            // Skipping an update is fine, blocking the compositor on a
            // renderer that stopped reading is not.
            if (renderer.stdin.has_pending()) {
                this._lastPointer = null;
                continue;
            }
            let line;
            if (renderer.builtin)
                line = `mouse ${pointer}`;
            else if (renderer.monitorIndex === monitor.index)
                line = position;
            else
                continue;
            this._write(renderer, line);
        }
    }

    // True when the topmost thing at this position is a desktop-type window:
    // the wallpaper itself or the Desktop Icons window above it.
    _isDesktopAt(x, y) {
        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
        while (actor && !(actor instanceof Meta.WindowActor))
            actor = actor.get_parent();
        return actor?.meta_window?.window_type === Meta.WindowType.DESKTOP;
    }

    _notify(message) {
        console.warn(`${this.uuid}: ${message}`);
        Main.notify('Paper Engine', message);
    }
}
