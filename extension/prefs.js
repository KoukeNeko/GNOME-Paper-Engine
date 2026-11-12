// SPDX-License-Identifier: GPL-3.0-or-later
//
// The wallpaper picker: navigation on the left, wallpapers in the middle,
// details of the selected wallpaper on the right.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    listProjects, loadProject, resolveProperties, findSceneRenderer, findAssetsDir, findWorkshopDirs, isSceneSupported,
    format, blurMyShellSettings, BLUR_MY_SHELL_COMPONENTS,
} from './library.js';
import {evaluateCondition} from './conditions.js';
import {downloadSceneAssets} from './sceneAssets.js';
import * as Workshop from './workshop.js';

const SUPPORTED_TYPES = ['video', 'web', 'scene'];
const PREVIEW_SIZE = 168;
// Cards are built in batches so decoding previews never freezes the window.
const CARDS_PER_BATCH = 12;
const SEARCH_DELAY_MS = 400;
// Options shown in the details pane before "show all".
const COLLAPSED_PROPERTIES = 6;
const DETAIL_PANE_WIDTH = 348;
// The one distance between a pane's edge and its content, and between blocks.
const MARGIN = 12;
// Cards and navigation rows carry this much padding of their own, so their
// containers are inset by the difference to keep content MARGIN from the edge.
const INSET = 6;

const STEAM_INSTALL_URI = 'steam://install/431960';

// Labels in these tables are translated where they are shown: gettext is not
// available yet while this module loads.
const N_ = text => text;

const TYPE_LABELS = {scene: N_('Scene'), video: N_('Video'), web: N_('Web')};
const FIT_LABELS = {cover: N_('Fill (crop)'), contain: N_('Fit (letterbox)'), fill: N_('Stretch')};
// Languages the picker can be switched to; the names are deliberately not translated.
const LANGUAGE_LABELS = {'': N_('System default'), en: 'English', zh_TW: '繁體中文'};
const PAUSE_LABELS = {
    maximized: N_('When a window is maximized or fullscreen'),
    fullscreen: N_('When a window is fullscreen'),
    never: N_('Never'),
};

// [view id, icon, label]; library views filter what is installed, workshop
// views query Steam.
const LIBRARY_VIEWS = [
    ['all', 'preferences-desktop-wallpaper-symbolic', N_('All')],
    ['scene', 'applications-graphics-symbolic', N_('Scene')],
    ['video', 'video-x-generic-symbolic', N_('Video')],
    ['web', 'web-browser-symbolic', N_('Web')],
    ['playlist', 'media-playlist-repeat-symbolic', N_('Playlist')],
];
const WORKSHOP_VIEWS = [
    ['trend', 'starred-symbolic', N_('Trending this week')],
    ['recent', 'document-open-recent-symbolic', N_('Most recent')],
    ['top', 'emblem-favorite-symbolic', N_('Most subscribed')],
];
const SUBSCRIBED_VIEW = ['subscribed', 'emblem-ok-symbolic', N_('Subscribed')];
const SETTINGS_VIEW = ['settings', 'emblem-system-symbolic', N_('Playback and performance')];
const VIEW_TITLES = {
    all: N_('All wallpapers'), scene: N_('Scene wallpapers'), video: N_('Video wallpapers'),
    web: N_('Web wallpapers'), subscribed: N_('Subscribed wallpapers'), playlist: N_('Playlist'),
    trend: N_('Workshop · Trending this week'), recent: N_('Workshop · Most recent'),
    top: N_('Workshop · Most subscribed'), settings: N_('Playback and performance'),
};
// Label → Workshop tag.
const WORKSHOP_TAGS = {
    [N_('Anime')]: 'Anime', [N_('Game')]: 'Game', [N_('Landscape')]: 'Landscape',
    [N_('Cyberpunk')]: 'Cyberpunk', [N_('Animal')]: 'Animal', '4K': '3840 x 2160',
};

const STYLE = `
.gpe-thumb, .gpe-hero, .gpe-now { border-radius: 12px; }
.gpe-card { padding: 6px; border-radius: 18px; }
.gpe-card:selected { background-color: alpha(@accent_bg_color, 0.28); }
.gpe-badge { background-color: rgba(0, 0, 0, 0.72); color: white; border-radius: 999px; padding: 2px 8px; font-size: 0.85em; font-weight: 600; margin: 6px; }
.gpe-badge.warning { color: #e6b24a; }
.gpe-unsupported picture { opacity: 0.35; }
.gpe-now { background-color: alpha(currentColor, 0.06); padding: 12px; }
.gpe-chip { border-radius: 999px; padding: 2px 12px; min-height: 28px; }
`;

function stripMarkup(text) {
    return text.replace(/<[^>]*>/g, '').trim();
}

// Wallpaper Engine labels built-in properties with localisation keys.
// Returns null for properties whose label is only markup (an image, a spacer):
// those are decoration in Wallpaper Engine's own editor, not options.
function propertyLabel(name, definition) {
    const raw = definition.text ?? '';
    const text = stripMarkup(raw);
    if (text === 'ui_browse_properties_scheme_color')
        return _('Scheme color');
    if (!text && raw.includes('<'))
        return null;
    return text || name;
}

function formatSize(bytes) {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function formatCount(count) {
    return count.toLocaleString();
}

function loadPreviewTexture(path, size = PREVIEW_SIZE * 2) {
    if (!path)
        return null;
    try {
        return Gdk.Texture.new_for_pixbuf(GdkPixbuf.Pixbuf.new_from_file_at_scale(path, size, size, true));
    } catch (e) {
        console.warn(`No preview for ${path}: ${e.message}`);
        return null;
    }
}

// Workshop previews are JPEG, PNG or GIF; GdkPixbuf reads all three.
function textureFromBytes(bytes) {
    return Gdk.Texture.new_for_pixbuf(
        GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes), null));
}

/** A combo row bound to an enum-like string setting. */
function createChoiceRow(settings, key, title, labels) {
    const nicks = Object.keys(labels);
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(Object.values(labels).map(label => _(label))),
        selected: nicks.indexOf(settings.get_string(key)),
    });
    row.connect('notify::selected', () => settings.set_string(key, nicks[row.selected]));
    return row;
}

/**
 * A wallpaper in the grid. `item` is either a library project (has `dir`) or
 * a Workshop result (has `id`).
 */
const WallpaperCard = GObject.registerClass(
class WallpaperCard extends Gtk.FlowBoxChild {
    constructor(item, meta) {
        // Centred, so the selection hugs the card instead of the grid cell.
        super({tooltip_text: item.title, css_classes: ['gpe-card'], halign: Gtk.Align.CENTER});
        this.item = item;

        this.picture = new Gtk.Picture({
            content_fit: Gtk.ContentFit.COVER,
            height_request: PREVIEW_SIZE,
            css_classes: ['gpe-thumb', 'card'],
            overflow: Gtk.Overflow.HIDDEN,
        });
        this._badge = new Gtk.Label({
            css_classes: ['gpe-badge'], halign: Gtk.Align.START, valign: Gtk.Align.START, visible: false,
        });
        const overlay = new Gtk.Overlay({child: this.picture});
        overlay.add_overlay(this._badge);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: INSET});
        // The clamp keeps the card at thumbnail width whatever the image size,
        // and the labels ask for no width of their own, so a long title is
        // cut off instead of widening every card of the grid.
        box.append(new Adw.Clamp({maximum_size: PREVIEW_SIZE, child: overlay}));
        box.append(new Gtk.Label({
            label: item.title, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 1, css_classes: ['heading'],
        }));
        box.append(new Gtk.Label({
            label: meta, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 1, css_classes: ['caption', 'dim-label'],
        }));
        this.set_child(box);
    }

    setBadge(text, warning = false) {
        this._badge.label = text ?? '';
        this._badge.visible = Boolean(text);
        if (warning)
            this._badge.add_css_class('warning');
        else
            this._badge.remove_css_class('warning');
    }
});

class Picker {
    constructor(window, settings, extensionPath) {
        this._window = window;
        this._extensionPath = extensionPath;
        this._settings = settings;
        this._view = 'all';
        this._projects = [];
        this._query = '';
        this._tag = null;
        this._workshopPage = 1;
        this._batchSourceId = 0;
        this._searchSourceId = 0;
        this._cancellable = new Gio.Cancellable();
        this._monitors = [];
        this._settingsIds = [];

        const provider = new Gtk.CssProvider();
        provider.load_from_string(STYLE);
        Gtk.StyleContext.add_provider_for_display(
            window.get_display(), provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        this._toastOverlay = new Adw.ToastOverlay({child: this._buildLayout()});
        window.set_content(this._toastOverlay);

        this._settingsIds.push(
            settings.connect('changed::wallpaper', () => this._onWallpaperChanged()),
            settings.connect('changed::monitor-wallpapers', () => this._onWallpaperChanged()),
            settings.connect('changed::paused', () => this._updateNowPlaying()),
            // Changing one option can reveal or hide others.
            settings.connect('changed::user-properties', () => this._refreshProperties?.()),
            settings.connect('changed::muted', () => this._updateNowPlaying()),
            settings.connect('changed::extra-dirs', () => this._reloadLibrary()),
            settings.connect('changed::playlist', () => this._onPlaylistChanged()));
        // Steam adds a directory here when a subscribed wallpaper is downloaded.
        for (const dir of findWorkshopDirs()) {
            try {
                const monitor = Gio.File.new_for_path(dir).monitor_directory(Gio.FileMonitorFlags.NONE, null);
                monitor.connect('changed', (_monitor, _file, _other, event) => {
                    if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT || event === Gio.FileMonitorEvent.DELETED)
                        this._reloadLibrary();
                });
                this._monitors.push(monitor);
            } catch (e) {
                console.warn(`Cannot watch ${dir}: ${e.message}`);
            }
        }
        window.connect('close-request', () => {
            this._destroy();
            return false;
        });

        this._reloadLibrary();
    }

    _destroy() {
        this._settingsIds.forEach(id => this._settings.disconnect(id));
        this._monitors.forEach(monitor => monitor.cancel());
        this._cancellable.cancel();
        Workshop.saveCache();
        if (this._batchSourceId)
            GLib.source_remove(this._batchSourceId);
        if (this._searchSourceId)
            GLib.source_remove(this._searchSourceId);
    }

    get _isWorkshopView() {
        return WORKSHOP_VIEWS.some(([id]) => id === this._view);
    }

    // ───────── Layout ─────────

    // The stock libadwaita split views, as in GNOME Settings or Files: they
    // give the sidebar its standard look and width and place the window
    // controls on whichever pane ends up at the edge.
    _buildLayout() {
        const contentWithDetails = new Adw.OverlaySplitView({
            sidebar_position: Gtk.PackType.END,
            sidebar: this._buildDetailPane(),
            content: this._buildContent(),
            min_sidebar_width: DETAIL_PANE_WIDTH,
            max_sidebar_width: DETAIL_PANE_WIDTH,
        });
        return new Adw.NavigationSplitView({
            sidebar: new Adw.NavigationPage({title: 'Paper Engine', child: this._buildSidebar()}),
            content: new Adw.NavigationPage({title: 'Paper Engine', child: contentWithDetails}),
            min_sidebar_width: 220,
            max_sidebar_width: 260,
        });
    }

    _buildSidebar() {
        const header = new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: 'Paper Engine'})});

        this._navRows = new Map();
        const navigation = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        const addSection = (title, views) => {
            navigation.append(new Gtk.Label({
                label: title, xalign: 0, css_classes: ['caption-heading', 'dim-label'],
                margin_start: MARGIN, margin_end: MARGIN, margin_top: MARGIN,
            }));
            const list = new Gtk.ListBox({css_classes: ['navigation-sidebar'], selection_mode: Gtk.SelectionMode.SINGLE});
            for (const [id, icon, label] of views) {
                const count = new Gtk.Label({css_classes: ['dim-label', 'caption', 'numeric']});
                const content = new Gtk.Box({spacing: 10});
                content.append(new Gtk.Image({icon_name: icon}));
                content.append(new Gtk.Label({label: _(label), xalign: 0, hexpand: true}));
                content.append(count);
                const row = new Gtk.ListBoxRow({child: content});
                row.viewId = id;
                list.append(row);
                this._navRows.set(id, {row, list, count});
            }
            list.connect('row-activated', (_list, row) => this._showView(row.viewId));
            navigation.append(list);
        };
        addSection(_('Library'), LIBRARY_VIEWS);
        addSection(_('Steam Workshop'), [...WORKSHOP_VIEWS, SUBSCRIBED_VIEW]);
        addSection(_('Preferences'), [SETTINGS_VIEW]);

        this._nowPlaying = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: MARGIN, css_classes: ['gpe-now'],
            margin_start: INSET, margin_end: INSET, margin_bottom: INSET,
        });

        const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        body.append(new Gtk.ScrolledWindow({child: navigation, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER}));
        body.append(this._nowPlaying);

        const view = new Adw.ToolbarView({content: body});
        view.add_top_bar(header);
        return view;
    }

    _buildContent() {
        this._title = new Adw.WindowTitle();
        this._searchEntry = new Gtk.SearchEntry({placeholder_text: _('Search wallpapers'), width_request: 240});
        this._searchEntry.connect('search-changed', () => this._onSearchChanged());
        const refreshButton = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: _('Refresh')});
        refreshButton.connect('clicked', () => {
            if (this._isWorkshopView)
                this._loadWorkshop(true);
            else
                this._reloadLibrary();
        });

        const header = new Adw.HeaderBar({title_widget: this._title});
        header.pack_end(refreshButton);
        header.pack_end(this._searchEntry);

        // Workshop tag filters.
        this._tagBar = new Gtk.Box({spacing: INSET, margin_start: MARGIN, margin_end: MARGIN, margin_top: MARGIN});
        for (const [label, tag] of Object.entries(WORKSHOP_TAGS)) {
            const chip = new Gtk.ToggleButton({label: _(label), css_classes: ['gpe-chip']});
            chip.connect('toggled', () => {
                if (chip.active) {
                    for (let other = this._tagBar.get_first_child(); other; other = other.get_next_sibling()) {
                        if (other !== chip)
                            other.active = false;
                    }
                    this._tag = tag;
                } else if (this._tag === tag) {
                    this._tag = null;
                } else {
                    return;
                }
                this._loadWorkshop(true);
            });
            this._tagBar.append(chip);
        }

        this._sceneNotice = new Adw.Banner();
        this._sceneNotice.connect('button-clicked', () => this._sceneNoticeAction?.());

        this._flowBox = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: false,
            homogeneous: true,
            valign: Gtk.Align.START,
            min_children_per_line: 2,
            max_children_per_line: 12,
            margin_start: INSET, margin_end: INSET, margin_top: INSET, margin_bottom: INSET,
        });
        this._flowBox.set_filter_func(card =>
            this._isWorkshopView || card.item.title.toLowerCase().includes(this._query.toLowerCase()));
        this._flowBox.connect('selected-children-changed', () => {
            const [card] = this._flowBox.get_selected_children();
            if (card)
                this._showDetails(card.item);
        });
        // Double-click (or Enter) applies an installed wallpaper.
        this._flowBox.connect('child-activated', (_box, card) => {
            if (card.item.dir && isSceneSupported(card.item))
                this._applyToAll(card.item.dir);
        });

        this._moreButton = new Gtk.Button({
            label: _('Load more'), halign: Gtk.Align.CENTER, css_classes: ['pill'], margin_top: INSET, margin_bottom: MARGIN, visible: false,
        });
        this._moreButton.connect('clicked', () => {
            this._workshopPage++;
            this._loadWorkshop(false);
        });

        const gridBox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        gridBox.append(this._flowBox);
        gridBox.append(this._moreButton);

        this._statusPage = new Adw.StatusPage();
        this._spinner = new Adw.Spinner({halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER, width_request: 48, height_request: 48});

        this._stack = new Gtk.Stack({vexpand: true, hexpand: true});
        this._stack.add_named(new Gtk.ScrolledWindow({child: gridBox, hscrollbar_policy: Gtk.PolicyType.NEVER}), 'grid');
        this._stack.add_named(this._statusPage, 'status');
        this._stack.add_named(this._spinner, 'loading');
        this._stack.add_named(this._buildSettingsPage(), 'settings');

        const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        body.append(this._sceneNotice);
        body.append(this._tagBar);
        body.append(this._stack);

        const view = new Adw.ToolbarView({content: body, hexpand: true});
        view.add_top_bar(header);
        return view;
    }

    _buildDetailPane() {
        this._detailBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: MARGIN,
            margin_start: MARGIN, margin_end: MARGIN, margin_top: MARGIN, margin_bottom: MARGIN,
        });
        const header = new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: _('Details')})});
        this._detailPane = new Adw.ToolbarView({
            content: new Gtk.ScrolledWindow({child: this._detailBox, hscrollbar_policy: Gtk.PolicyType.NEVER}),
        });
        this._detailPane.add_top_bar(header);
        return this._detailPane;
    }

    // ───────── Navigation ─────────

    _showView(view) {
        this._view = view;
        for (const {row, list} of this._navRows.values()) {
            if (row.viewId === view)
                list.select_row(row);
            else
                list.unselect_row(row);
        }
        this._title.title = _(VIEW_TITLES[view]);
        this._title.subtitle = '';
        this._tagBar.visible = this._isWorkshopView;
        this._searchEntry.visible = view !== 'settings';
        this._searchEntry.placeholder_text = this._isWorkshopView ? _('Search the Workshop') : _('Search wallpapers');
        this._moreButton.visible = false;

        if (view === 'settings') {
            this._stack.visible_child_name = 'settings';
            this._clearDetails(_('Adjust playback, volume and when to pause.'));
        } else if (this._isWorkshopView) {
            this._loadWorkshop(true);
        } else {
            this._populateLibrary();
        }
    }

    _onSearchChanged() {
        this._query = this._searchEntry.text;
        if (!this._isWorkshopView) {
            this._flowBox.invalidate_filter();
            return;
        }
        // Don't query Steam on every keystroke.
        if (this._searchSourceId)
            GLib.source_remove(this._searchSourceId);
        this._searchSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SEARCH_DELAY_MS, () => {
            this._searchSourceId = 0;
            this._loadWorkshop(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    // ───────── Library ─────────

    _reloadLibrary() {
        this._projects = listProjects(this._settings.get_strv('extra-dirs'))
            .filter(project => SUPPORTED_TYPES.includes(project.type));

        const countOf = type => this._projects.filter(project => project.type === type).length;
        this._navRows.get('all').count.label = `${this._projects.length}`;
        for (const type of SUPPORTED_TYPES)
            this._navRows.get(type).count.label = `${countOf(type)}`;
        this._navRows.get('subscribed').count.label = `${this._projects.filter(project => project.workshopId).length}`;
        this._updatePlaylistCount();

        if (!this._installingRenderer && !this._downloadingAssets) {
            const hasScenes = countOf('scene') > 0;
            if (hasScenes && !findSceneRenderer(this._settings.get_string('scene-renderer'))) {
                this._sceneNotice.revealed = true;
                this._setSceneNotice(_('Scene wallpapers need the scene renderer'), _('Install'),
                    () => this._confirmRendererInstall());
            } else if (hasScenes && !findAssetsDir()) {
                this._sceneNotice.revealed = true;
                this._setSceneNotice(_('Scene wallpapers need the scene assets'), _('Download'),
                    () => this._confirmAssetsDownload());
            } else {
                this._sceneNotice.revealed = false;
            }
        }
        this._updateNowPlaying();
        // Workshop views don't show the library, but their "subscribed" state depends on it.
        if (this._isWorkshopView)
            this._refreshBadges();
        else if (this._view !== 'settings')
            this._showView(this._view);
    }

    // ───────── Scene renderer ─────────

    _setSceneNotice(title, buttonLabel, action) {
        this._sceneNotice.title = title;
        this._sceneNotice.button_label = buttonLabel ?? '';
        this._sceneNoticeAction = action;
    }

    _confirmRendererInstall() {
        const dialog = new Adw.AlertDialog({
            heading: _('Install the scene renderer?'),
            body: _('Downloads about 1 GB and builds for a few minutes. Nothing is installed system-wide.'),
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('install', _('Install'));
        dialog.set_response_appearance('install', Adw.ResponseAppearance.SUGGESTED);
        dialog.connect('response', (_dialog, response) => {
            if (response === 'install')
                this._installRenderer();
        });
        dialog.present(this._window);
    }

    // Runs the setup script that ships with the extension; what it prints goes
    // to a log that is offered when it fails.
    _installRenderer() {
        const bundled = GLib.build_filenamev([this._extensionPath, 'setup-scene-renderer.sh']);
        const script = GLib.file_test(bundled, GLib.FileTest.IS_EXECUTABLE)
            ? bundled : GLib.find_program_in_path('gnome-paper-engine-setup-scene');
        const logDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-paper-engine']);
        const log = GLib.build_filenamev([logDir, 'setup-scene-renderer.log']);
        const fail = () => {
            this._installingRenderer = false;
            this._setSceneNotice(_('The scene renderer could not be installed'), _('Show log'),
                () => Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(log).get_uri(), null));
        };

        this._installingRenderer = true;
        this._setSceneNotice(_('Installing the scene renderer'), null, null);
        let subprocess;
        try {
            if (!script)
                throw new Error('The setup script is not installed');
            GLib.mkdir_with_parents(logDir, 0o755);
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDERR_MERGE,
            });
            launcher.set_stdout_file_path(log);
            subprocess = launcher.spawnv([script]);
        } catch (e) {
            console.error(e);
            GLib.file_set_contents(log, `${e.message}\n`);
            fail();
            return;
        }
        subprocess.wait_async(null, () => {
            if (!subprocess.get_successful()) {
                fail();
                return;
            }
            this._installingRenderer = false;
            this._reloadLibrary();
        });
    }

    _confirmAssetsDownload() {
        const account = new Adw.EntryRow({title: _('Steam account name')});
        const fields = new Adw.PreferencesGroup();
        fields.add(account);
        const dialog = new Adw.AlertDialog({
            heading: _('Download the scene assets?'),
            body: _('Signs in to Steam with SteamCMD and downloads the Windows version of Wallpaper Engine, about 800 MB, keeping only its assets. The account must own Wallpaper Engine.'),
            extra_child: fields,
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('download', _('Download'));
        dialog.set_response_appearance('download', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_response_enabled('download', false);
        account.connect('changed', () => dialog.set_response_enabled('download', account.text.trim() !== ''));
        account.connect('entry-activated', () => {
            if (account.text.trim() !== '') {
                dialog.close();
                this._downloadAssets(account.text.trim());
            }
        });
        dialog.connect('response', (_dialog, response) => {
            if (response === 'download')
                this._downloadAssets(account.text.trim());
        });
        dialog.present(this._window);
    }

    // Answers a SteamCMD prompt: 'password' or 'code'. Resolves to null when cancelled.
    _askSteam(kind) {
        const entry = kind === 'password'
            ? new Adw.PasswordEntryRow({title: _('Password')})
            : new Adw.EntryRow({title: _('Code')});
        const fields = new Adw.PreferencesGroup();
        fields.add(entry);
        const dialog = new Adw.AlertDialog({
            heading: kind === 'password' ? _('Steam password') : _('Steam Guard code'),
            body: kind === 'password' ? '' : _('Enter the code from the Steam Mobile app or from the email Steam sent.'),
            extra_child: fields,
        });
        dialog.add_response('cancel', _('Cancel'));
        dialog.add_response('sign-in', _('Sign in'));
        dialog.set_response_appearance('sign-in', Adw.ResponseAppearance.SUGGESTED);
        dialog.set_response_enabled('sign-in', false);
        entry.connect('changed', () => dialog.set_response_enabled('sign-in', entry.text !== ''));
        return new Promise(resolve => {
            let answered = false;
            const answer = text => {
                if (!answered) {
                    answered = true;
                    resolve(text);
                }
            };
            entry.connect('entry-activated', () => {
                if (entry.text !== '') {
                    answer(entry.text);
                    dialog.close();
                }
            });
            dialog.connect('response', (_dialog, response) => answer(response === 'sign-in' ? entry.text : null));
            dialog.present(this._window);
        });
    }

    async _downloadAssets(account) {
        const log = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-paper-engine', 'download-scene-assets.log']);
        const statusTitles = {
            'steamcmd': _('Installing SteamCMD'),
            'signing-in': _('Signing in to Steam'),
            'confirm': _('Approve the sign-in in the Steam Mobile app'),
            'downloading': _('Downloading the scene assets'),
            'installing': _('Installing the scene assets'),
        };
        const failureTitles = {
            'sign-in': _('Steam did not accept the sign-in'),
            'rate-limit': _('Steam is limiting sign-ins. Try again later.'),
            'not-owned': _('This Steam account does not own Wallpaper Engine'),
        };
        this._downloadingAssets = true;
        try {
            await downloadSceneAssets({
                account,
                ask: kind => this._askSteam(kind),
                onStatus: status => this._setSceneNotice(statusTitles[status], null, null),
                log,
                cancellable: this._cancellable,
            });
        } catch (e) {
            this._downloadingAssets = false;
            if (this._cancellable.is_cancelled())
                return;
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                this._reloadLibrary();
                return;
            }
            console.error(e);
            this._setSceneNotice(failureTitles[e.reason] ?? _('The scene assets could not be downloaded'), _('Show log'),
                () => Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(log).get_uri(), null));
            return;
        }
        this._downloadingAssets = false;
        this._reloadLibrary();
    }

    _populateLibrary() {
        const inUse = this._inUseDirs();
        const projects = this._projects
            .filter(project => {
                switch (this._view) {
                case 'all': return true;
                case 'subscribed': return project.workshopId;
                case 'playlist': return this._settings.get_strv('playlist').includes(project.dir);
                default: return project.type === this._view;
                }
            })
            // The active wallpaper comes first so it is visible right away.
            .sort((a, b) => inUse.has(b.dir) - inUse.has(a.dir));

        this._title.subtitle = format(_('%s wallpapers'), projects.length);
        if (projects.length === 0) {
            this._showStatus({
                icon: 'preferences-desktop-wallpaper-symbolic',
                title: _('No wallpapers here yet'),
                description: _('Install Wallpaper Engine in Steam, then subscribe to wallpapers in the Workshop; they show up here once Steam has downloaded them.'),
                action: [_('Install Wallpaper Engine'), () => Gio.AppInfo.launch_default_for_uri(STEAM_INSTALL_URI, null)],
            });
            this._clearDetails(_('Select a wallpaper to see its details.'));
            return;
        }
        this._fillGrid(projects.map(project => () => {
            const card = new WallpaperCard(project, _(TYPE_LABELS[project.type]));
            card.picture.set_paintable(loadPreviewTexture(project.preview));
            if (!isSceneSupported(project))
                card.add_css_class('gpe-unsupported');
            return card;
        }), true);
    }

    // ───────── Workshop ─────────

    async _loadWorkshop(reset) {
        if (reset) {
            this._workshopPage = 1;
            this._stack.visible_child_name = 'loading';
            this._clearDetails(_('Select a wallpaper to see its details.'));
        }
        this._moreButton.sensitive = false;
        const request = {sort: this._view, query: this._query, tag: this._tag, page: this._workshopPage};
        this._workshopRequest = request;

        let results;
        try {
            results = await Workshop.browse(request, this._cancellable);
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) || this._workshopRequest !== request)
                return;
            console.error(e);
            this._showStatus({
                icon: 'network-error-symbolic',
                title: _('Could not load the Workshop'),
                description: e.message,
                action: [_('Retry'), () => this._loadWorkshop(true)],
            });
            return;
        }
        // A newer request (other view, search or tag) superseded this one.
        if (this._workshopRequest !== request)
            return;

        if (reset && results.length === 0) {
            this._showStatus({icon: 'edit-find-symbolic', title: _('No matching wallpapers'),
                description: _('Try another keyword or tag.'),});
            return;
        }
        this._fillGrid(results.map(result => () => {
            const subscribers = format(_('%s subscribers'), formatCount(result.subscriptions));
            const card = new WallpaperCard(result, `${_(TYPE_LABELS[result.type])} · ${subscribers}`);
            Workshop.fetchPreview(result.previewUrl, PREVIEW_SIZE * 2, this._cancellable)
                .then(bytes => card.picture.set_paintable(textureFromBytes(bytes)))
                .catch(e => {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`No preview for Workshop item ${result.id}: ${e.message}`);
                });
            return card;
        }), reset);
        this._moreButton.visible = results.length > 0;
        this._moreButton.sensitive = true;
    }

    // ───────── Grid ─────────

    /** `factories` create the cards; `reset` replaces the grid instead of appending. */
    _fillGrid(factories, reset) {
        if (this._batchSourceId)
            GLib.source_remove(this._batchSourceId);
        if (reset)
            this._flowBox.remove_all();
        this._stack.visible_child_name = 'grid';

        const pending = [...factories];
        this._batchSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            for (const factory of pending.splice(0, CARDS_PER_BATCH))
                this._flowBox.append(factory());
            this._refreshBadges();
            if (reset && !this._flowBox.get_selected_children().length) {
                const first = this._flowBox.get_child_at_index(0);
                if (first)
                    this._flowBox.select_child(first);
            }
            if (pending.length > 0)
                return GLib.SOURCE_CONTINUE;
            this._batchSourceId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    _libraryProjectFor(item) {
        return item.dir ? item : this._projects.find(project => project.workshopId === item.id) ?? null;
    }

    _refreshBadges() {
        const inUse = this._inUseDirs();
        for (let card = this._flowBox.get_first_child(); card; card = card.get_next_sibling()) {
            const project = this._libraryProjectFor(card.item);
            if (project && inUse.has(project.dir))
                card.setBadge(`● ${_('In use')}`);
            else if (project && !isSceneSupported(project))
                card.setBadge(_('Not supported'), true);
            else if (project && !card.item.dir)
                card.setBadge(_('Subscribed'));
            else
                card.setBadge(null);
        }
    }

    _showStatus({icon, title, description, action = null}) {
        this._statusPage.icon_name = icon;
        this._statusPage.title = title;
        this._statusPage.description = description;
        let button = null;
        if (action) {
            button = new Gtk.Button({label: action[0], halign: Gtk.Align.CENTER, css_classes: ['pill', 'suggested-action']});
            button.connect('clicked', action[1]);
        }
        this._statusPage.set_child(button);
        this._stack.visible_child_name = 'status';
    }

    // ───────── Details ─────────

    _clearDetails(message) {
        this._selected = null;
        this._refreshProperties = null;
        this._replaceDetails([new Adw.StatusPage({description: message, vexpand: true})]);
    }

    _replaceDetails(widgets) {
        for (let child = this._detailBox.get_first_child(); child; child = this._detailBox.get_first_child())
            this._detailBox.remove(child);
        widgets.forEach(widget => this._detailBox.append(widget));
    }

    _showDetails(item) {
        this._selected = item;
        this._refreshProperties = null;
        const project = this._libraryProjectFor(item);
        const inUse = this._inUseDirs();

        const hero = new Gtk.Picture({
            content_fit: Gtk.ContentFit.COVER, height_request: 308, css_classes: ['gpe-hero', 'card'],
            overflow: Gtk.Overflow.HIDDEN,
        });
        if (item.dir) {
            hero.set_paintable(loadPreviewTexture(item.preview, 640));
        } else {
            // Show the grid thumbnail until the larger image has arrived.
            const [card] = this._flowBox.get_selected_children();
            if (card?.item === item)
                hero.set_paintable(card.picture.paintable);
            Workshop.fetchPreview(item.previewUrl, 640, this._cancellable)
                .then(bytes => hero.set_paintable(textureFromBytes(bytes)))
                .catch(e => console.warn(`No preview for Workshop item ${item.id}: ${e.message}`));
        }

        const widgets = [
            hero,
            new Gtk.Label({label: item.title, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, css_classes: ['title-3']}),
        ];
        const addCaption = (text, classes = ['dim-label']) => widgets.push(new Gtk.Label({
            label: text, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, css_classes: classes,
        }));
        const pill = (label, classes, onClicked) => {
            const button = new Gtk.Button({label, css_classes: ['pill', ...classes]});
            if (onClicked)
                button.connect('clicked', onClicked);
            else
                button.sensitive = false;
            return button;
        };

        const isInUse = Boolean(project) && inUse.has(project.dir);
        if (item.dir) {
            addCaption([
                _(TYPE_LABELS[item.type]), item.workshopId ? _('Steam Workshop') : _('Local wallpaper'),
                ...isInUse ? [_('In use')] : [],
            ].join(' · '));
        }
        else
            addCaption(`${'★'.repeat(item.stars)}${'☆'.repeat(5 - item.stars)}  ${format(_('%s ratings'), item.votes)}`);

        // The one primary action of the pane.
        if (project && !isSceneSupported(project)) {
            widgets.push(pill(_('Cannot be applied'), [], null));
            addCaption(_('This scene uses a 3D perspective camera, which the scene renderer cannot show yet.'), ['warning']);
        } else if (isInUse) {
            widgets.push(pill(_('Stop wallpaper'), [], () => this._applyToAll('')));
        } else if (project) {
            widgets.push(pill(_('Apply wallpaper'), ['suggested-action'], () => this._applyToAll(project.dir)));
        } else {
            widgets.push(pill(format(_('Subscribe in Steam (%s)'), formatSize(item.size)), ['suggested-action'], () => {
                Gio.AppInfo.launch_default_for_uri(Workshop.steamPageUri(item.id), null);
                this._toastOverlay.add_toast(new Adw.Toast({title: _('Opened in Steam: press Subscribe there and it downloads automatically.')}));
            }));
            addCaption(_('Subscribing goes through your Steam account; the wallpaper appears in the library once it is downloaded.'), ['dim-label', 'caption']);
        }
        // Everything else the wallpaper can do, as one list.
        const actions = new Adw.PreferencesGroup();
        const addAction = (title, onActivated) => {
            const row = new Adw.ButtonRow({title});
            row.connect('activated', onActivated);
            actions.add(row);
            if (!widgets.includes(actions))
                widgets.push(actions);
        };
        // With several monitors, a wallpaper can also go on just one of them.
        const monitors = this._window.get_display().get_monitors();
        if (project && isSceneSupported(project) && monitors.get_n_items() > 1) {
            for (let i = 0; i < monitors.get_n_items(); i++) {
                const connector = monitors.get_item(i).get_connector();
                addAction(format(_('Apply to %s only'), connector), () => {
                    const perMonitor = this._monitorWallpapers();
                    perMonitor[connector] = project.dir;
                    this._settings.set_string('monitor-wallpapers', JSON.stringify(perMonitor));
                });
            }
        }
        if (project && isSceneSupported(project)) {
            const inPlaylist = this._settings.get_strv('playlist').includes(project.dir);
            addAction(inPlaylist ? _('Remove from playlist') : _('Add to playlist'), () => {
                const playlist = this._settings.get_strv('playlist');
                this._settings.set_strv('playlist', inPlaylist
                    ? playlist.filter(dir => dir !== project.dir) : [...playlist, project.dir]);
            });
        }
        const workshopId = item.dir ? item.workshopId : item.id;
        if (workshopId && project) {
            addAction(_('Open Workshop page in Steam'), () =>
                Gio.AppInfo.launch_default_for_uri(Workshop.steamPageUri(workshopId), null));
        }

        if (!item.dir) {
            const info = new Adw.PreferencesGroup({title: _('About this wallpaper')});
            for (const [title, value] of [
                [_('Subscribers'), formatCount(item.subscriptions)],
                [_('Favorites'), formatCount(item.favorited)],
                [_('Updated'), GLib.DateTime.new_from_unix_local(item.updated).format('%x')],
                [_('Tags'), item.tags.join(', ')],
            ]) {
                const row = new Adw.ActionRow({title, subtitle: GLib.markup_escape_text(value, -1), css_classes: ['property']});
                info.add(row);
            }
            widgets.push(info);
            if (item.description) {
                const description = new Adw.PreferencesGroup({title: _('Description')});
                description.add(new Gtk.Label({
                    label: item.description, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, selectable: true,
                }));
                widgets.push(description);
            }
        } else if (isSceneSupported(item)) {
            const group = this._createPropertiesGroup(item);
            if (group)
                widgets.push(group);
        }

        this._replaceDetails(widgets);
    }

    _createPropertiesGroup(project) {
        const entries = Object.entries(project.properties)
            .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
            .map(([name, definition]) => ({definition, row: this._createPropertyRow(project.dir, name, definition)}))
            .filter(({row}) => row !== null);
        if (entries.length === 0)
            return null;

        const group = new Adw.PreferencesGroup({title: _('Options')});
        entries.forEach(({row}) => group.add(row));
        const showAll = new Adw.ButtonRow();
        group.add(showAll);

        // An option is listed when its condition holds for the current values;
        // of those, only the first few until "show all" is pressed.
        let expanded = false;
        const refresh = () => {
            let overrides = {};
            try {
                overrides = JSON.parse(this._settings.get_string('user-properties'))[project.dir] ?? {};
            } catch {
                // Malformed overrides: fall back to the wallpaper's defaults.
            }
            const values = resolveProperties(project, overrides);
            const applicable = entries.filter(({definition}) =>
                !definition.condition || evaluateCondition(definition.condition, values));
            for (const {row} of entries)
                row.visible = false;
            applicable.forEach(({row}, index) => (row.visible = expanded || index < COLLAPSED_PROPERTIES));
            group.description = format(_('%s options'), applicable.length);
            showAll.title = format(_('Show all %s options'), applicable.length);
            showAll.visible = !expanded && applicable.length > COLLAPSED_PROPERTIES;
        };
        showAll.connect('activated', () => {
            expanded = true;
            refresh();
        });
        this._refreshProperties = refresh;
        refresh();
        return group;
    }

    _createPropertyRow(dir, name, definition) {
        const settings = this._settings;
        const allOverrides = () => {
            try {
                return JSON.parse(settings.get_string('user-properties'));
            } catch {
                return {};
            }
        };
        const current = allOverrides()[dir]?.[name] ?? definition.value;
        const save = value => {
            const overrides = allOverrides();
            overrides[dir] = {...overrides[dir], [name]: value};
            settings.set_string('user-properties', JSON.stringify(overrides));
        };
        const label = propertyLabel(name, definition);
        if (label === null)
            return null;
        const title = GLib.markup_escape_text(label, -1);

        switch (definition.type) {
        case 'bool': {
            const row = new Adw.SwitchRow({title, active: Boolean(current)});
            row.connect('notify::active', () => save(row.active));
            return row;
        }
        case 'slider': {
            const fractional = definition.fraction ?? !Number.isInteger(definition.step ?? definition.value);
            const row = new Adw.SpinRow({
                title,
                digits: fractional ? 2 : 0,
                adjustment: new Gtk.Adjustment({
                    lower: definition.min ?? 0,
                    upper: definition.max ?? 100,
                    step_increment: definition.step ?? (fractional ? 0.05 : 1),
                    value: Number(current),
                }),
            });
            row.connect('notify::value', () => save(row.value));
            return row;
        }
        case 'color': {
            // Stored as "r g b" with components in 0…1.
            const [red, green, blue] = String(current).split(' ').map(Number);
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}),
                rgba: new Gdk.RGBA({red, green, blue, alpha: 1}),
                valign: Gtk.Align.CENTER,
            });
            button.connect('notify::rgba', () => {
                const {red: r, green: g, blue: b} = button.rgba;
                save([r, g, b].map(component => Number(component.toFixed(5))).join(' '));
            });
            const row = new Adw.ActionRow({title});
            row.add_suffix(button);
            return row;
        }
        case 'combo': {
            const options = definition.options ?? [];
            const row = new Adw.ComboRow({
                title,
                model: Gtk.StringList.new(options.map(option => stripMarkup(option.label ?? String(option.value)))),
                selected: Math.max(0, options.findIndex(option => String(option.value) === String(current))),
            });
            row.connect('notify::selected', () => save(options[row.selected].value));
            return row;
        }
        case 'textinput': {
            const row = new Adw.EntryRow({title, text: String(current ?? ''), show_apply_button: true});
            row.connect('apply', () => save(row.text));
            return row;
        }
        default:
            // Group headings, file pickers and other types have no editor here.
            return null;
        }
    }

    /** Per-monitor wallpapers: {connector name: project directory}. */
    _monitorWallpapers() {
        try {
            return JSON.parse(this._settings.get_string('monitor-wallpapers'));
        } catch {
            return {};
        }
    }

    /** Project directories shown on at least one monitor. */
    _inUseDirs() {
        return new Set([this._settings.get_string('wallpaper'), ...Object.values(this._monitorWallpapers())]
            .filter(dir => dir));
    }

    /** Shows one wallpaper (or none, for '') on every monitor. */
    _applyToAll(dir) {
        this._settings.set_string('monitor-wallpapers', '{}');
        this._settings.set_string('wallpaper', dir);
    }

    _updatePlaylistCount() {
        const playlist = this._settings.get_strv('playlist');
        this._navRows.get('playlist').count.label =
            `${this._projects.filter(project => playlist.includes(project.dir)).length}`;
    }

    _onPlaylistChanged() {
        this._updatePlaylistCount();
        if (this._view === 'playlist')
            this._populateLibrary();
        else if (this._selected)
            this._showDetails(this._selected);
    }

    // ───────── Now playing ─────────

    _onWallpaperChanged() {
        this._updateNowPlaying();
        this._refreshBadges();
        if (this._selected)
            this._showDetails(this._selected);
    }

    _updateNowPlaying() {
        for (let child = this._nowPlaying.get_first_child(); child; child = this._nowPlaying.get_first_child())
            this._nowPlaying.remove(child);

        const dir = this._settings.get_string('wallpaper');
        const project = dir ? loadProject(dir) : null;
        if (!project) {
            this._nowPlaying.append(new Gtk.Label({label: _('No live wallpaper applied'), xalign: 0, css_classes: ['dim-label']}));
            return;
        }
        const paused = this._settings.get_boolean('paused');
        const muted = this._settings.get_boolean('muted');

        this._nowPlaying.append(new Gtk.Label({
            label: paused ? _('Paused') : _('Playing'), xalign: 0, css_classes: ['caption', paused ? 'warning' : 'success'],
        }));
        const info = new Gtk.Box({spacing: MARGIN});
        const thumbnail = new Gtk.Picture({
            content_fit: Gtk.ContentFit.COVER, width_request: 44, height_request: 44,
            css_classes: ['gpe-thumb'], overflow: Gtk.Overflow.HIDDEN, can_shrink: true,
            paintable: loadPreviewTexture(project.preview),
        });
        info.append(new Adw.Clamp({maximum_size: 44, child: thumbnail}));
        info.append(new Gtk.Label({label: project.title, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, css_classes: ['heading']}));
        this._nowPlaying.append(info);

        const controls = new Gtk.Box({spacing: INSET, homogeneous: true});
        const control = (icon, tooltip, onClicked) => {
            const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip});
            button.connect('clicked', onClicked);
            controls.append(button);
        };
        control(paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic', paused ? _('Resume') : _('Pause'),
            () => this._settings.set_boolean('paused', !paused));
        control(muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic', muted ? _('Unmute') : _('Mute'),
            () => this._settings.set_boolean('muted', !muted));
        control('media-playback-stop-symbolic', _('Stop wallpaper'), () => this._applyToAll(''));
        this._nowPlaying.append(controls);
    }

    // ───────── Settings ─────────

    _buildSettingsPage() {
        const settings = this._settings;
        const page = new Adw.PreferencesPage();

        const playback = new Adw.PreferencesGroup({title: _('Playback')});
        page.add(playback);

        const mutedRow = new Adw.SwitchRow({title: _('Mute wallpaper audio')});
        settings.bind('muted', mutedRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        playback.add(mutedRow);

        const volumeRow = new Adw.SpinRow({
            title: _('Volume'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5}),
        });
        settings.bind('volume', volumeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        playback.add(volumeRow);

        playback.add(createChoiceRow(settings, 'fit', _('Scaling'), FIT_LABELS));
        playback.add(createChoiceRow(settings, 'pause-mode', _('Pause automatically'), PAUSE_LABELS));

        const lockScreenRow = new Adw.SwitchRow({
            title: _('Show on the lock screen'),
            subtitle: _('When off, playback pauses while the screen is locked'),
        });
        settings.bind('show-on-lock-screen', lockScreenRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        playback.add(lockScreenRow);

        const systemBackgroundRow = new Adw.SwitchRow({
            title: _('Still image as desktop background'),
            subtitle: _('Shown while the live wallpaper is not running'),
        });
        settings.bind('system-background', systemBackgroundRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        playback.add(systemBackgroundRow);

        const rotation = new Adw.PreferencesGroup({
            title: _('Playlist'),
            description: _('Add wallpapers to the playlist from their details, then let them rotate.'),
        });
        page.add(rotation);
        const intervalRow = new Adw.SpinRow({
            title: _('Change wallpaper every'),
            subtitle: _('Minutes; 0 turns rotation off'),
            adjustment: new Gtk.Adjustment({lower: 0, upper: 1440, step_increment: 5}),
        });
        settings.bind('rotation-interval', intervalRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        rotation.add(intervalRow);
        const shuffleRow = new Adw.SwitchRow({title: _('Shuffle')});
        settings.bind('rotation-shuffle', shuffleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        rotation.add(shuffleRow);

        // Blur my Shell blurs the Dock and the top bar either from the wallpaper
        // alone or from everything behind them; with a live wallpaper the
        // difference shows, so its two switches are offered here as well.
        const blurTitles = {'dash-to-dock': _('Windows behind the Dock'), 'panel': _('Windows behind the top bar')};
        const blurRows = BLUR_MY_SHELL_COMPONENTS
            .map(component => [blurMyShellSettings(component), blurTitles[component]])
            .filter(([blurSettings]) => blurSettings);
        if (blurRows.length > 0) {
            const blur = new Adw.PreferencesGroup({title: 'Blur my Shell'});
            page.add(blur);
            for (const [blurSettings, title] of blurRows) {
                const row = new Adw.SwitchRow({title});
                blurSettings.bind('static-blur', row, 'active', Gio.SettingsBindFlags.INVERT_BOOLEAN);
                blur.add(row);
            }
        }

        const appearance = new Adw.PreferencesGroup({title: _('Interface')});
        page.add(appearance);
        const languageRow = createChoiceRow(settings, 'language', _('Language'), LANGUAGE_LABELS);
        languageRow.subtitle = _('Takes effect the next time this window is opened');
        appearance.add(languageRow);

        const folders = new Adw.PreferencesGroup({
            title: _('Other wallpaper folders'),
            description: _('Each sub-folder is one wallpaper (with a project.json). Steam libraries are found automatically.'),
        });
        page.add(folders);

        const addButton = new Gtk.Button({icon_name: 'list-add-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: _('Add folder')});
        addButton.connect('clicked', () => {
            new Gtk.FileDialog({title: _('Choose a wallpaper folder')}).select_folder(this._window, null, (dialog, result) => {
                let folder;
                try {
                    folder = dialog.select_folder_finish(result);
                } catch (e) {
                    if (e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                        return;
                    throw e;
                }
                const dirs = settings.get_strv('extra-dirs');
                if (!dirs.includes(folder.get_path()))
                    settings.set_strv('extra-dirs', [...dirs, folder.get_path()]);
            });
        });
        folders.set_header_suffix(addButton);

        let folderRows = [];
        const rebuildFolders = () => {
            folderRows.forEach(row => folders.remove(row));
            folderRows = settings.get_strv('extra-dirs').map(dir => {
                const row = new Adw.ActionRow({title: GLib.markup_escape_text(dir, -1)});
                const removeButton = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: _('Remove')});
                removeButton.connect('clicked', () =>
                    settings.set_strv('extra-dirs', settings.get_strv('extra-dirs').filter(other => other !== dir)));
                row.add_suffix(removeButton);
                folders.add(row);
                return row;
            });
        };
        this._settingsIds.push(settings.connect('changed::extra-dirs', rebuildFolders));
        rebuildFolders();
        return page;
    }
}

export default class PaperEnginePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // gettext consults LANGUAGE on every lookup, so this has to happen before any text is built.
        const language = settings.get_string('language');
        if (language)
            GLib.setenv('LANGUAGE', language, true);

        window.set_title('Paper Engine');
        // Wide enough for four columns of wallpapers between the two side panes.
        window.set_default_size(1440, 900);
        window.set_search_enabled(false);
        new Picker(window, settings, this.path);
    }
}
