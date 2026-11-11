// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renderer for "video" and "web" Wallpaper Engine projects.
//
// Runs as a separate process (GTK 3 + WebKitGTK, both part of a stock Ubuntu
// install) and opens one undecorated window per monitor. The shell extension
// turns those windows into desktop-layer windows and talks to this process
// over stdin, one command per line: pause | play | mute 0|1 | volume 0-100 |
// mouse INDEX X Y BUTTON.

import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gst from 'gi://Gst';
import Gtk from 'gi://Gtk?version=3.0';
import WebKit from 'gi://WebKit2?version=4.1';

// Must match RENDERER_TITLE_PREFIX in extension.js.
const TITLE_PREFIX = 'gnome-paper-engine-renderer-';

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
        type: '', file: '', fit: 'cover', muted: false, volume: 100,
        monitors: '0', properties: '{}',
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
    // Indices of the monitors to open a window for, e.g. "0,2".
    options.monitors = options.monitors.split(',').map(Number);
    options.volume = Number(options.volume);
    if (!['video', 'web'].includes(options.type) || !options.file)
        throw new Error('Usage: renderer.js --type video|web --file PATH [--fit MODE] [--muted] [--volume N] [--monitors I,J,…] [--properties JSON]');
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

class Renderer {
    constructor(options) {
        this._options = options;
        this._paused = false;
        // Monitor index → WebView.
        this._views = new Map();
        // Per window: whether the forwarded pointer has its button pressed.
        this._buttonDown = [];
        for (const index of options.monitors)
            this._views.set(index, this._createWindow(index));
        this._readCommands();
    }

    _createWindow(index) {
        const {type, file, fit, muted} = this._options;

        const contentManager = new WebKit.UserContentManager();
        if (type === 'web') {
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
            // Exit non-zero so the extension relaunches us.
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

        const window = new Gtk.Window({
            title: `${TITLE_PREFIX}${index}`,
            decorated: false,
            default_width: 1280,
            default_height: 720,
        });
        window.add(view);
        window.connect('destroy', () => Gtk.main_quit());
        window.show_all();
        return view;
    }

    _onLoaded(view) {
        const {type, volume, properties} = this._options;
        if (type === 'video') {
            this._runJs(view, `document.querySelector('video').volume = ${volume / 100};`);
        } else {
            // The properties argument is JSON, which is also a valid JS literal.
            this._runJs(view, `
                window.wallpaperPropertyListener?.applyGeneralProperties?.({fps: 60});
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

    _handleCommand(line) {
        const [command, argument, ...rest] = line.trim().split(' ');
        switch (command) {
        case 'mouse': {
            // mouse <window index> <x> <y> <button down>, position as fractions of the window.
            const index = Number(argument);
            const view = this._views.get(index);
            if (view) {
                const down = rest[2] === '1';
                const events = ['mousemove'];
                if (down !== Boolean(this._buttonDown[index]))
                    events.push(...down ? ['mousedown'] : ['mouseup', 'click']);
                this._buttonDown[index] = down;
                this._runJs(view, `{
                    const x = ${Number(rest[0])} * innerWidth, y = ${Number(rest[1])} * innerHeight;
                    const target = document.elementFromPoint(x, y) ?? document;
                    for (const type of ${JSON.stringify(events)}) {
                        target.dispatchEvent(new MouseEvent(type, {
                            clientX: x, clientY: y, screenX: x, screenY: y, button: 0,
                            buttons: ${down ? 1 : 0}, bubbles: true, cancelable: true, view: window,
                        }));
                    }
                }`);
            }
            break;
        }
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
                    // The extension went away (shell exit or crash); don't linger.
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

Gtk.init(null);
new Renderer(parseArgs(ARGV));
Gtk.main();
