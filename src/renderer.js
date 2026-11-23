// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renderer for "video" and "web" Wallpaper Engine projects.
//
// Runs as a separate process (GTK 3 + WebKitGTK) and opens one wlr-layer-shell
// surface per display, under the windows, through gtk-layer-shell, which must
// be loaded before libwayland-client (LD_PRELOAD). Nekoland hands those
// surfaces the pointer where nothing else is. The daemon talks to this process
// over stdin, one command per line: pause | play | mute 0|1 | volume 0-100 |
// still DISPLAY PATH.

import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import GtkLayerShell from 'gi://GtkLayerShell?version=0.1';
import Gst from 'gi://Gst';
import Gtk from 'gi://Gtk?version=3.0';
import WebKit from 'gi://WebKit2?version=4.1';

// The name of this program's sound streams; must match OWN_STREAM_NAMES in daemon.js.
const PROGRAM_NAME = 'nekoland-paper-engine-renderer';
// Nekoland draws its bottom layer over its background layer, where its own wallpaper (swaybg) is.
const LAYER_NAMESPACE = 'nekoland-paper-engine';

const FIT_TO_OBJECT_FIT = {cover: 'cover', contain: 'contain', fill: 'fill'};

// What Wallpaper Engine hands an audio listener: 64 frequency bands for the
// left channel followed by 64 for the right, each 0…1.
const AUDIO_BANDS_PER_CHANNEL = 64;
const AUDIO_FRAME_NS = 33_000_000;
// Bands quieter than this count as silence. A single band of ordinary music
// sits around -40…-15 dB, so levels are taken from this dB range (squared, to
// keep quiet passages low) rather than from the raw amplitude, which would
// leave every bar near zero.
const AUDIO_FLOOR_DB = -60;
// The analyser yields twice as many (linear) bands as are used: the upper
// half of the spectrum is nearly empty for music and would leave half the
// bars of a visualiser flat.
const AUDIO_PIPELINE = `pulsesrc device=@DEFAULT_MONITOR@ ! audioconvert ! audio/x-raw,channels=2 !
    spectrum bands=${AUDIO_BANDS_PER_CHANNEL * 2} interval=${AUDIO_FRAME_NS} threshold=${AUDIO_FLOOR_DB} multi-channel=true ! fakesink sync=false`;

// Wallpaper Engine's web API registers listeners through these globals; pages
// call them unconditionally, so they have to exist even where we feed no data.
// The audio listener tells the renderer about itself, so system audio is only
// captured for wallpapers that use it.
const WEB_API_STUBS = `
window.wallpaperRegisterAudioListener = listener => {
    window.__paperEngineAudioListener = listener;
    window.webkit.messageHandlers.paperEngine.postMessage('audio');
};
window.wallpaperRegisterMediaStatusListener = () => {};
window.wallpaperRegisterMediaPropertiesListener = () => {};
window.wallpaperRegisterMediaThumbnailListener = () => {};
window.wallpaperRegisterMediaPlaybackListener = () => {};
window.wallpaperRegisterMediaTimelineListener = () => {};
window.wallpaperRequestRandomFileForProperty = () => {};
`;

function parseArgs(argv) {
    const options = {
        type: '', file: '', fit: 'cover', fps: 30, muted: false, volume: 100,
        outputs: '[]', properties: '{}',
    };
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i].replace(/^--/, '');
        if (name === 'muted')
            options.muted = true;
        else if (name in options)
            options[name] = argv[++i];
        else
            throw new Error(`Unknown argument: ${argv[i]}`);
    }
    // The displays to open a surface on, as [{name, x, y}], their place in points.
    options.outputs = JSON.parse(options.outputs);
    options.volume = Number(options.volume);
    options.fps = Number(options.fps);
    if (!['video', 'web'].includes(options.type) || !options.file)
        throw new Error('Usage: renderer.js --type video|web --file PATH [--fit MODE] [--fps N] [--muted] [--volume N] [--outputs JSON] [--properties JSON]');
    return options;
}

function videoPage(file, fit) {
    const src = GLib.markup_escape_text(Gio.File.new_for_path(file).get_uri(), -1);
    return `<!doctype html>
<html><body style="margin:0;background:#000;overflow:hidden">
<video src="${src}" autoplay loop playsinline
       style="width:100vw;height:100vh;object-fit:${FIT_TO_OBJECT_FIT[fit] ?? 'cover'}"></video>
</body></html>`;
}

/**
 * Web wallpapers are pages written by strangers, loaded from file:// so that
 * their video and audio play. This content filter keeps them to the files of
 * their own folder: without it a page could read anything in the user's home
 * directory and send it away.
 */
function compileFolderFilter(folder) {
    const folderUri = Gio.File.new_for_path(folder).get_uri().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rules = [
        {trigger: {'url-filter': '^file:', 'url-filter-is-case-sensitive': true}, action: {type: 'block'}},
        {trigger: {'url-filter': `^${folderUri}/`, 'url-filter-is-case-sensitive': true}, action: {type: 'ignore-previous-rules'}},
    ];
    const store = new WebKit.UserContentFilterStore({
        path: GLib.build_filenamev([GLib.get_user_cache_dir(), 'nekoland-paper-engine', 'content-filters']),
    });
    return new Promise((resolve, reject) => {
        // One filter per folder: several renderers may be compiling theirs at once.
        const identifier = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, folder, -1);
        store.save(identifier, new GLib.Bytes(new TextEncoder().encode(JSON.stringify(rules))), null,
            (_store, result) => {
                try {
                    resolve(store.save_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

class Renderer {
    /** `folderFilter` confines a web wallpaper to its folder; null for videos. */
    constructor(options, folderFilter) {
        this._options = options;
        this._folderFilter = folderFilter;
        this._paused = false;
        // Display name → WebView.
        this._views = new Map();
        for (const output of options.outputs)
            this._views.set(output.name, this._createWindow(output));
        this._readCommands();
    }

    _createWindow(output) {
        const {type, file, fit, muted} = this._options;

        const contentManager = new WebKit.UserContentManager();
        if (type === 'web') {
            contentManager.add_filter(this._folderFilter);
            contentManager.register_script_message_handler('paperEngine');
            contentManager.connect('script-message-received::paperEngine', () => this._startAudioCapture());
            contentManager.add_script(new WebKit.UserScript(
                WEB_API_STUBS,
                WebKit.UserContentInjectedFrames.TOP_FRAME,
                WebKit.UserScriptInjectionTime.START,
                null, null));
        }

        const view = new WebKit.WebView({
            user_content_manager: contentManager,
            website_policies: new WebKit.WebsitePolicies({autoplay: WebKit.AutoplayPolicy.ALLOW}),
            is_muted: muted,
        });
        const settings = view.get_settings();
        // Web wallpapers are local pages that fetch their own assets.
        settings.allow_file_access_from_file_urls = true;
        settings.allow_universal_access_from_file_urls = true;
        settings.media_playback_requires_user_gesture = false;
        settings.enable_webgl = true;
        settings.hardware_acceleration_policy = WebKit.HardwareAccelerationPolicy.ALWAYS;
        view.set_background_color(new Gdk.RGBA({red: 0, green: 0, blue: 0, alpha: 1}));

        view.connect('load-changed', (_view, event) => {
            if (event === WebKit.LoadEvent.FINISHED)
                this._onLoaded(view);
        });
        view.connect('web-process-terminated', () => {
            // Exit non-zero so the daemon relaunches us.
            printerr('Web process terminated');
            imports.system.exit(1);
        });
        // A wallpaper has no use for a context menu.
        view.connect('context-menu', () => true);

        if (type === 'video') {
            view.load_html(videoPage(file, fit), 'file:///');
        } else {
            view.load_uri(Gio.File.new_for_path(file).get_uri());
        }

        const window = new Gtk.Window({title: PROGRAM_NAME, decorated: false});
        GtkLayerShell.init_for_window(window);
        GtkLayerShell.set_namespace(window, LAYER_NAMESPACE);
        GtkLayerShell.set_layer(window, GtkLayerShell.Layer.BOTTOM);
        // GDK 3 does not know the displays' names, so they are told apart by where they are.
        const display = Gdk.Display.get_default();
        for (let i = 0; i < display.get_n_monitors(); i++) {
            const geometry = display.get_monitor(i).get_geometry();
            if (geometry.x === output.x && geometry.y === output.y)
                GtkLayerShell.set_monitor(window, display.get_monitor(i));
        }
        for (const edge of [GtkLayerShell.Edge.LEFT, GtkLayerShell.Edge.RIGHT, GtkLayerShell.Edge.TOP, GtkLayerShell.Edge.BOTTOM])
            GtkLayerShell.set_anchor(window, edge, true);
        // Under the menu bar and the Dock too, rather than beside them.
        GtkLayerShell.set_exclusive_zone(window, -1);
        GtkLayerShell.set_keyboard_mode(window, GtkLayerShell.KeyboardMode.NONE);
        window.add(view);
        window.connect('destroy', () => Gtk.main_quit());
        window.show_all();
        return view;
    }

    _onLoaded(view) {
        const {type, volume, fps, properties} = this._options;
        if (type === 'video') {
            this._runJs(view, `document.querySelector('video').volume = ${volume / 100};`);
        } else {
            // The properties argument is JSON, which is also a valid JS literal.
            this._runJs(view, `
                window.wallpaperPropertyListener?.applyGeneralProperties?.({fps: ${fps}});
                window.wallpaperPropertyListener?.applyUserProperties?.(${properties});
            `);
        }
        if (this._paused)
            this._setPaused(true);
    }

    _runJs(view, script) {
        view.evaluate_javascript(script, -1, null, null, null, (_view, result) => {
            try {
                view.evaluate_javascript_finish(result);
            } catch (e) {
                printerr(`Wallpaper script error: ${e.message}`);
            }
        });
    }

    // Analyses what the system is playing and feeds it to the pages' audio listeners.
    _startAudioCapture() {
        if (this._audioPipeline)
            return;
        try {
            Gst.init(null);
            this._audioPipeline = Gst.parse_launch(AUDIO_PIPELINE);
        } catch (e) {
            printerr(`Audio capture is not available: ${e.message}`);
            return;
        }
        const bus = this._audioPipeline.get_bus();
        bus.add_signal_watch();
        bus.connect('message::element', (_bus, message) => {
            const structure = message.get_structure();
            if (structure.get_name() !== 'spectrum')
                return;
            // The magnitudes are nested GValue arrays, which GJS cannot unpack;
            // their text form lists the left channel's bands, then the right's, in dB.
            const text = structure.to_string();
            const decibels = [...text.slice(text.indexOf('magnitude=')).matchAll(/\(float\)(-?[\d.]+)/g)]
                .map(([, value]) => Number(value));
            const perChannel = decibels.length / 2;
            const levels = [0, perChannel].flatMap(start => decibels
                .slice(start, start + AUDIO_BANDS_PER_CHANNEL)
                .map(db => (Math.min(1, Math.max(0, 1 - db / AUDIO_FLOOR_DB)) ** 2).toFixed(4)));
            for (const view of this._views.values())
                this._runJs(view, `window.__paperEngineAudioListener?.([${levels}]);`);
        });
        bus.connect('message::error', (_bus, message) => {
            const [error] = message.parse_error();
            printerr(`Audio capture stopped: ${error.message}`);
        });
        this._audioPipeline.set_state(this._paused ? Gst.State.PAUSED : Gst.State.PLAYING);
    }

    _setPaused(paused) {
        this._paused = paused;
        this._audioPipeline?.set_state(paused ? Gst.State.PAUSED : Gst.State.PLAYING);
        const call = paused ? 'pause()' : 'play()';
        for (const view of this._views.values()) {
            this._runJs(view, `
                document.querySelectorAll('video, audio').forEach(media => media.${call});
                window.wallpaperPropertyListener?.setPaused?.(${paused});
            `);
        }
    }

    _saveStill(view, path) {
        view?.get_snapshot(WebKit.SnapshotRegion.VISIBLE, WebKit.SnapshotOptions.NONE, null, (_view, result) => {
            try {
                view.get_snapshot_finish(result).writeToPNG(path);
            } catch (e) {
                printerr(`No still of the wallpaper: ${e.message}`);
            }
        });
    }

    _handleCommand(line) {
        const [command, argument, ...rest] = line.trim().split(' ');
        switch (command) {
        case 'still':
            // still <display> <path>: a PNG of what that display shows.
            this._saveStill(this._views.get(argument), rest.join(' '));
            break;
        case 'pause':
            this._setPaused(true);
            break;
        case 'play':
            this._setPaused(false);
            break;
        case 'mute':
            for (const view of this._views.values())
                view.is_muted = argument === '1';
            break;
        case 'volume':
            this._options.volume = Number(argument);
            for (const view of this._views.values()) {
                this._runJs(view, `document.querySelectorAll('video, audio').forEach(
                    media => { media.volume = ${this._options.volume / 100}; });`);
            }
            break;
        default:
            printerr(`Unknown command: ${line}`);
        }
    }

    _readCommands() {
        const stdin = new Gio.DataInputStream({
            base_stream: new GioUnix.InputStream({fd: 0, close_fd: false}),
        });
        const readNext = () => {
            stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (_stream, result) => {
                const [line] = stdin.read_line_finish_utf8(result);
                if (line === null) {
                    // The daemon went away; don't linger.
                    Gtk.main_quit();
                    return;
                }
                this._handleCommand(line);
                readNext();
            });
        };
        readNext();
    }
}

GLib.set_prgname(PROGRAM_NAME);
Gtk.init(null);
const options = parseArgs(ARGV);
// Without its filter a web wallpaper is not shown at all: a failure here ends the process.
new Renderer(options, options.type === 'web' ? await compileFolderFilter(GLib.path_get_dirname(options.file)) : null);
Gtk.main();
