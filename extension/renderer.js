// SPDX-License-Identifier: GPL-3.0-or-later
//
// Renderer for "video" and "web" Wallpaper Engine projects.
//
// Runs as a separate process (GTK 3 + WebKitGTK, both part of a stock Ubuntu
// install) and opens one undecorated window per monitor. The shell extension
// turns those windows into desktop-layer windows and talks to this process
// over stdin, one command per line: pause | play | mute 0|1 | volume 0-100 |
// mouse INDEX X Y.

import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import WebKit from 'gi://WebKit2?version=4.1';

// Must match RENDERER_TITLE_PREFIX in extension.js.
const TITLE_PREFIX = 'gnome-wallpaper-engine-renderer-';

const FIT_TO_OBJECT_FIT = {cover: 'cover', contain: 'contain', fill: 'fill'};

// Wallpaper Engine's web API registers listeners through these globals; pages
// call them unconditionally, so they have to exist even where we feed no data.
const WEB_API_STUBS = `
window.wallpaperRegisterAudioListener = () => {};
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
        monitors: 1, properties: '{}',
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
    options.monitors = Number(options.monitors);
    options.volume = Number(options.volume);
    if (!['video', 'web'].includes(options.type) || !options.file)
        throw new Error('Usage: renderer.js --type video|web --file PATH [--fit MODE] [--muted] [--volume N] [--monitors N] [--properties JSON]');
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
        this._views = [];
        for (let i = 0; i < options.monitors; i++)
            this._views.push(this._createWindow(i));
        this._readCommands();
    }

    _createWindow(index) {
        const {type, file, fit, muted} = this._options;

        const contentManager = new WebKit.UserContentManager();
        if (type === 'web') {
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

    _setPaused(paused) {
        this._paused = paused;
        const call = paused ? 'pause()' : 'play()';
        for (const view of this._views) {
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
            // mouse <window index> <x> <y>, position as fractions of the window.
            const view = this._views[Number(argument)];
            if (view) {
                this._runJs(view, `{
                    const x = ${Number(rest[0])} * innerWidth, y = ${Number(rest[1])} * innerHeight;
                    (document.elementFromPoint(x, y) ?? document).dispatchEvent(new MouseEvent('mousemove', {
                        clientX: x, clientY: y, screenX: x, screenY: y, bubbles: true, view: window,
                    }));
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
            for (const view of this._views)
                view.is_muted = argument === '1';
            break;
        case 'volume':
            this._options.volume = Number(argument);
            for (const view of this._views) {
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
