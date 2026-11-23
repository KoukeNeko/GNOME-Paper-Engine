// SPDX-License-Identifier: GPL-3.0-or-later
//
// Runs the wallpaper renderers on Nekoland. Each draws one wlr-layer-shell
// surface per display on the bottom layer, which Nekoland draws under the
// windows and the desktop's icons and over its own wallpaper on the
// background layer. Started from Nekoland's autostart, and by the picker;
// a second one started finds the first running and exits.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import System from 'system';

import {
    loadProject, resolveProperties, findSceneRenderer, findAssetsDir, format, listGpus, getSettings,
    gettext as _, APP_DIR, DATA_DIR} from './library.js';
import {
    run, nekolandMsg, parseDisplays, parseWindowAreas, isEveryDisplayCovered, parseConfigWallpaper,
    isOtherAudioPlaying} from './session.js';

const APPLICATION_ID = 'io.github.koukeneko.Nekoland.PaperEngine.Daemon';
// Must match the window title set in picker.js.
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
// How often the displays, the windows and the sound streams are looked at.
const POLL_INTERVAL_MS = 1000;
// Nekoland's maximized windows leave the menu bar and the Dock their room, so
// a window over this much of a display counts as maximized.
const MAXIMIZED_SHARE = 0.8;
// How long a wallpaper gets to load before a still of it is taken, and how
// long the renderer then gets to write it.
const STILL_DELAY_MS = 5000;
const STILL_WRITE_MS = 1000;
// Each still gets a name of its own: Nekoland draws its wallpaper anew, and
// its overview forgets the old picture, only when the path changes.
const STILL_PREFIX = 'still-';

// Settings that only take effect by restarting the renderer.
const RELAUNCH_KEYS = [
    'wallpaper', 'monitor-wallpapers', 'fit', 'scene-renderer', 'user-properties', 'fps', 'render-scale', 'particles', 'gpu',
];
// Settings that decide whether the wallpaper plays.
const PLAYBACK_KEYS = ['paused', 'when-focused', 'when-maximized', 'when-fullscreen', 'when-audio', 'when-on-battery'];
const WINDOW_KEYS = ['when-focused', 'when-maximized', 'when-fullscreen'];
// The nicks of the PlaybackAction enum, weakest first: when several
// conditions hold, the strongest of their actions is taken.
const PLAYBACK_ACTIONS = ['keep', 'mute', 'pause', 'stop'];
// What the sound streams of the wallpaper's renderers are called: the
// built-in renderer's PROGRAM_NAME, and the scene renderer's binary.
const OWN_STREAM_NAMES = ['nekoland-paper-engine-renderer', 'linux-wallpaperengine'];

const SCENE_SCALING = {cover: 'fill', contain: 'fit', fill: 'stretch'};

// How often per second the daemon may redo something that keeps getting
// undone, before it concludes that something else is working against it.
const REPEAT_LIMIT = 10;
const REPEAT_WINDOW_MS = 1000;

const SIGSTOP = 19;
const SIGCONT = 18;

function isStill(path) {
    return path.startsWith(GLib.build_filenamev([DATA_DIR, STILL_PREFIX]));
}

// The stills left over from before, all but `keep`.
function removeStills(keep = null) {
    const enumerator = Gio.File.new_for_path(DATA_DIR).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = enumerator.next_file(null));) {
        const path = GLib.build_filenamev([DATA_DIR, info.get_name()]);
        if (isStill(path) && path !== keep)
            Gio.File.new_for_path(path).delete(null);
    }
}

async function setNekolandWallpaper(path) {
    // Nekoland answers a setting it could not keep with why.
    const reply = (await nekolandMsg(path ? `set wallpaper = ${JSON.stringify(path)}` : 'unset wallpaper')).trim();
    if (reply)
        throw new Error(reply);
}

class Daemon {
    constructor(application) {
        this._application = application;
    }

    start() {
        this._settings = getSettings();
        // {subprocess, pid, stdin, builtin, outputs, stillPath, startTime}. Only the
        // built-in renderer reads commands; the scene renderer on Wayland reads nothing.
        this._renderers = [];
        // What Nekoland and PipeWire said at the last look.
        this._displays = null;
        this._windows = [];
        this._otherAudio = false;
        this._polling = false;
        this._pollError = '';
        // [{name, environment}] once switcheroo-control has answered.
        this._gpus = null;
        listGpus().catch(e => {
            console.warn(`Cannot list the GPUs: ${e.message}`);
            return [];
        }).then(gpus => {
            this._gpus = gpus;
            if (this._settings.get_string('gpu'))
                this._launch();
        });
        // What the daemon keeps redoing → {since, count} within the current second.
        this._repeats = new Map();
        this._failures = 0;
        this._paused = false;
        // Muted by a playback rule, on top of the user's own setting.
        this._muted = false;
        // Ended by a playback rule, to be started again when it no longer applies.
        this._stopped = false;
        this._relaunchId = 0;
        this._pauseCheckId = 0;
        this._rotationId = 0;
        this._stillId = 0;
        this._settings.connect('changed', (_settings, key) => this._onSettingChanged(key));

        this._upower = null;
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
            'org.freedesktop.UPower', '/org/freedesktop/UPower', 'org.freedesktop.UPower',
            null, (_source, result) => {
                try {
                    this._upower = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (e) {
                    console.warn(`Power source unknown, ignoring battery power: ${e.message}`);
                    return;
                }
                this._upower.connect('g-properties-changed', () => this._queuePauseCheck());
                this._queuePauseCheck();
            });

        this._scheduleRotation();
        // The first look at the displays launches the wallpaper.
        this._poll();
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        for (const id of [this._pollId, this._relaunchId, this._pauseCheckId, this._rotationId, this._stillId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._stop();
    }

    async _poll() {
        if (this._polling)
            return;
        this._polling = true;
        try {
            await this._look();
        } finally {
            this._polling = false;
        }
    }

    async _look() {
        let displays;
        try {
            displays = parseDisplays(await nekolandMsg('displays'));
        } catch (e) {
            // Also how the session ending shows: Nekoland is gone.
            console.error(`Nekoland is not answering: ${e.message}`);
            this._application.quit();
            return;
        }
        // Said once, not every second.
        const warn = e => {
            if (e.message !== this._pollError)
                console.warn(e.message);
            this._pollError = e.message;
            return null;
        };
        if (WINDOW_KEYS.some(key => this._settings.get_string(key) !== 'keep')) {
            const windows = await nekolandMsg('window-areas').then(parseWindowAreas, warn);
            // The picker does not count as an application in the way.
            this._windows = (windows ?? []).filter(window => window.title !== PICKER_TITLE);
        } else {
            this._windows = [];
        }
        if (this._settings.get_string('when-audio') !== 'keep') {
            const objects = await run(['pw-dump']).then(JSON.parse, warn);
            this._otherAudio = isOtherAudioPlaying(objects ?? [], this._renderers.map(({pid}) => pid), OWN_STREAM_NAMES);
        } else {
            this._otherAudio = false;
        }
        if (JSON.stringify(displays) !== JSON.stringify(this._displays)) {
            this._displays = displays;
            this._launch();
        } else {
            this._applyPlayback();
        }
        // A scene's sound stream may only show up after it was muted.
        if (this._muted)
            this._muteScenes(true);
    }

    _onSettingChanged(key) {
        const commandable = this._renderers.every(renderer => renderer.builtin);
        if (key === 'muted' && commandable) {
            this._sendMute();
        } else if (key === 'volume' && commandable) {
            this._sendCommand(`volume ${this._settings.get_int('volume')}`);
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
        // Nothing to launch on before the displays are known; a chosen GPU is
        // only known once the list has arrived, which then launches.
        if (this._displays === null || (this._gpus === null && this._settings.get_string('gpu')))
            return;
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

        for (const [dir, displays] of this._wallpaperAssignments())
            this._launchProject(dir, displays);

        this._queuePauseCheck();
        this._scheduleStill();
    }

    // Nekoland's wallpaper becomes a still of the wallpaper: it is what shows
    // before the wallpaper starts (at login, or should the renderer fail), on
    // the lock screen and in the overview, and what the menu bar takes the
    // colour of its text from.
    _scheduleStill() {
        if (this._stillId) {
            GLib.source_remove(this._stillId);
            this._stillId = 0;
        }
        if (this._renderers.length === 0 || !this._settings.get_boolean('system-background')) {
            this._restoreWallpaper();
            return;
        }
        const main = this._displays[0]?.name;
        const renderer = this._renderers.find(({outputs}) => outputs.includes(main));
        if (!renderer)
            return;
        // A scene renderer was told where to write it when it started.
        const path = renderer.stillPath ?? GLib.build_filenamev([DATA_DIR, `${STILL_PREFIX}${GLib.get_real_time()}.png`]);
        this._stillId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STILL_DELAY_MS, () => {
            if (renderer.builtin)
                this._write(renderer, `still ${main} ${path}`);
            this._stillId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STILL_WRITE_MS, () => {
                this._stillId = 0;
                this._applyStill(path).catch(e => console.warn(`No still of the wallpaper: ${e.message}`));
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    async _applyStill(path) {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            throw new Error(`the renderer wrote no ${path}`);
        // Switched off or stopped while the picture was being written.
        if (!this._settings.get_boolean('system-background') || this._renderers.length === 0) {
            removeStills();
            return;
        }
        const current = parseConfigWallpaper(await nekolandMsg('config'));
        if (this._settings.get_value('previous-background').deepUnpack() === null && !isStill(current))
            this._settings.set_value('previous-background', new GLib.Variant('ms', current));
        await setNekolandWallpaper(path);
        removeStills(path);
    }

    _restoreWallpaper() {
        const previous = this._settings.get_value('previous-background').deepUnpack();
        if (previous === null)
            return;
        this._settings.set_value('previous-background', new GLib.Variant('ms', null));
        nekolandMsg('config').then(async config => {
            // A wallpaper picked in the meantime is the user's to keep.
            if (isStill(parseConfigWallpaper(config)))
                await setNekolandWallpaper(previous);
            removeStills();
        }).catch(e => console.warn(`Cannot put Nekoland's wallpaper back: ${e.message}`));
    }

    // Which wallpaper goes on which displays: Map of project directory →
    // displays. Displays without an entry of their own in monitor-wallpapers
    // (keyed by connector name) get the default wallpaper.
    _wallpaperAssignments() {
        let perDisplay = {};
        try {
            perDisplay = JSON.parse(this._settings.get_string('monitor-wallpapers'));
        } catch (e) {
            console.warn(`Ignoring malformed monitor-wallpapers: ${e.message}`);
        }
        const assignments = new Map();
        for (const display of this._displays) {
            const dir = perDisplay[display.name] ?? this._settings.get_string('wallpaper');
            if (!dir)
                continue;
            if (!assignments.has(dir))
                assignments.set(dir, []);
            assignments.get(dir).push(display);
        }
        return assignments;
    }

    _launchProject(dir, displays) {
        const project = loadProject(dir);
        if (!project) {
            this._notify(format(_('No wallpaper project found in %s'), dir));
            return;
        }

        let overrides = {};
        try {
            overrides = JSON.parse(this._settings.get_string('user-properties'))[dir] ?? {};
        } catch (e) {
            console.warn(`Ignoring malformed user-properties: ${e.message}`);
        }
        const properties = resolveProperties(project, overrides);

        try {
            if (project.type === 'video' || project.type === 'web')
                this._spawnBuiltinRenderer(project, properties, displays);
            else if (project.type === 'scene')
                this._spawnSceneRenderers(project, properties, displays);
            else
                this._notify(format(_('“%s” is a “%s” wallpaper, which is not supported'), project.title, project.type));
        } catch (e) {
            console.error(e);
            this._notify(format(_('Could not start the wallpaper renderer: %s'), e.message));
        }
    }

    _spawnBuiltinRenderer(project, properties, displays) {
        const argv = [
            'gjs', '-m', GLib.build_filenamev([APP_DIR, 'renderer.js']),
            '--type', project.type,
            '--file', project.file,
            '--fit', this._settings.get_string('fit'),
            '--fps', `${this._settings.get_int('fps')}`,
            '--volume', `${this._settings.get_int('volume')}`,
            '--outputs', JSON.stringify(displays.map(({name, x, y}) => ({name, x, y}))),
            // Wallpaper Engine hands pages their properties as {name: {value}}.
            '--properties', JSON.stringify(Object.fromEntries(
                Object.entries(properties).map(([name, value]) => [name, {value}]))),
        ];
        if (this._settings.get_boolean('muted'))
            argv.push('--muted');
        // gtk-layer-shell has to come before libwayland-client, which GJS loads first.
        const preload = ['libgtk-layer-shell.so.0', GLib.getenv('LD_PRELOAD')].filter(Boolean).join(' ');
        this._spawn(argv, Gio.SubprocessFlags.STDIN_PIPE, {LD_PRELOAD: preload}, displays, null);
    }

    // One scene renderer per display, each with the display it is on.
    _spawnSceneRenderers(project, properties, displays) {
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

        for (const display of displays) {
            const argv = [
                binary,
                '--assets-dir', assetsDir,
                // A layer-shell surface on the bottom layer of this display.
                '--screen-root', display.name,
                '--bg', project.dir,
                '--scaling', SCENE_SCALING[this._settings.get_string('fit')],
                '--fps', `${this._settings.get_int('fps')}`,
                // Joined with = so that a renderer built before the option ignores it whole.
                `--render-scale=${this._settings.get_string('render-scale')}`,
                '--volume', `${this._settings.get_int('volume')}`,
                // Pausing is driven by this daemon instead.
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
            let stillPath = null;
            if (display === this._displays[0] && this._settings.get_boolean('system-background')) {
                stillPath = GLib.build_filenamev([DATA_DIR, `${STILL_PREFIX}${GLib.get_real_time()}.png`]);
                argv.push('--screenshot', stillPath);
            }
            this._spawn(argv, Gio.SubprocessFlags.STDOUT_SILENCE, {}, [display], stillPath);
        }
    }

    _spawn(argv, flags, environment, displays, stillPath) {
        const launcher = new Gio.SubprocessLauncher({flags});
        const gpu = this._gpus?.find(({name}) => name === this._settings.get_string('gpu'));
        for (const [name, value] of Object.entries({...gpu?.environment, ...environment}))
            launcher.setenv(name, value, true);
        GLib.mkdir_with_parents(DATA_DIR, 0o755);
        const subprocess = launcher.spawnv(argv);
        const renderer = {
            subprocess,
            pid: Number(subprocess.get_identifier()),
            stdin: subprocess.get_stdin_pipe(),
            // Lines waiting for the write under way to finish.
            queue: [],
            builtin: Boolean(flags & Gio.SubprocessFlags.STDIN_PIPE),
            outputs: displays.map(({name}) => name),
            stillPath,
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
            console.warn('Renderer exited unexpectedly, relaunching');
            this._relaunchId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RELAUNCH_DELAY_MS, () => {
                this._relaunchId = 0;
                this._launch();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _stop() {
        const renderers = this._renderers;
        this._renderers = [];
        this._paused = false;
        this._muted = false;
        // SIGKILL also ends a renderer that is currently SIGSTOPped.
        for (const {subprocess} of renderers)
            subprocess.force_exit();
    }

    // The daemon puts things back the way it wants them. If something else
    // keeps undoing that, doing it again at once makes the two flicker against
    // each other for ever. Past a few times a second it is left as it is
    // instead, and the log says what was being repeated.
    _mayRepeat(action) {
        const now = GLib.get_monotonic_time() / 1000;
        let record = this._repeats.get(action);
        if (!record || now - record.since > REPEAT_WINDOW_MS) {
            record = {since: now, count: 0};
            this._repeats.set(action, record);
        }
        record.count++;
        if (record.count === REPEAT_LIMIT + 1)
            console.warn(`${action} more than ${REPEAT_LIMIT} times a second; leaving it be`);
        return record.count <= REPEAT_LIMIT;
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
        const actions = [];
        if (this._upower?.get_cached_property('OnBattery')?.unpack())
            actions.push(this._settings.get_string('when-on-battery'));
        // PipeWire tells a stream that plays from one that is only open.
        if (this._otherAudio)
            actions.push(this._settings.get_string('when-audio'));
        // shortcut: Nekoland's IPC names no focused window, so any window on
        // screen counts; ask Nekoland for the focus should a rule need it exactly.
        if (this._windows.length > 0)
            actions.push(this._settings.get_string('when-focused'));
        if (this._displays && isEveryDisplayCovered(this._displays, this._windows, 1))
            actions.push(this._settings.get_string('when-fullscreen'));
        if (this._displays && isEveryDisplayCovered(this._displays, this._windows, MAXIMIZED_SHARE))
            actions.push(this._settings.get_string('when-maximized'));
        return PLAYBACK_ACTIONS[Math.max(0, ...actions.map(action => PLAYBACK_ACTIONS.indexOf(action)))];
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

    // One that runs muted by the user's setting already gets no sound to unmute.
    _sendMute() {
        const muted = this._muted || this._settings.get_boolean('muted');
        this._sendCommand(`mute ${muted ? 1 : 0}`);
        this._muteScenes(muted);
    }

    // The scene renderer reads no commands on Wayland: its streams are muted in PipeWire.
    _muteScenes(muted) {
        for (const {pid, builtin} of this._renderers) {
            if (!builtin) {
                run(['wpctl', 'set-mute', '--pid', `${pid}`, muted ? '1' : '0'])
                    .catch(e => console.warn(`Cannot mute the scene: ${e.message}`));
            }
        }
    }

    _sendCommand(command) {
        for (const renderer of this._renderers) {
            if (renderer.builtin)
                this._write(renderer, command);
        }
    }

    // Never blocks: a renderer that stopped reading must not stall the daemon.
    // A stream takes one write at a time, so a line written while another is
    // under way follows it.
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

    // Nekoland serves the notifications itself.
    _notify(message) {
        console.warn(message);
        Gio.DBus.session.call('org.freedesktop.Notifications', '/org/freedesktop/Notifications',
            'org.freedesktop.Notifications', 'Notify',
            new GLib.Variant('(susssasa{sv}i)', ['Paper Engine', 0, 'nekoland-paper-engine', 'Paper Engine', message, [], {}, -1]),
            null, Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (e) {
                    console.warn(`Cannot show a notification: ${e.message}`);
                }
            });
    }
}

const application = new Gio.Application({application_id: APPLICATION_ID});
const daemon = new Daemon(application);
application.connect('startup', () => {
    application.hold();
    daemon.start();
});
// Started again while running: nothing more to do.
application.connect('activate', () => {});
application.connect('shutdown', () => daemon.stop());
for (const signal of [1, 2, 15]) {
    // SIGHUP, SIGINT and SIGTERM: the scene renderers would outlive the daemon otherwise.
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, signal, () => {
        application.quit();
        return GLib.SOURCE_REMOVE;
    });
}
application.run([System.programInvocationName]);
