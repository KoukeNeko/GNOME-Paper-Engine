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

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {listProjects, loadProject, findSceneRenderer, findWorkshopDirs, isSceneSupported} from './library.js';
import * as Workshop from './workshop.js';

const SUPPORTED_TYPES = ['video', 'web', 'scene'];
const PREVIEW_SIZE = 168;
// Cards are built in batches so decoding previews never freezes the window.
const CARDS_PER_BATCH = 12;
const SEARCH_DELAY_MS = 400;
// Options shown in the details pane before "show all".
const COLLAPSED_PROPERTIES = 6;

const STEAM_INSTALL_URI = 'steam://install/431960';

const TYPE_LABELS = {scene: '場景', video: '影片', web: '網頁'};
const FIT_LABELS = {cover: '填滿（裁切）', contain: '完整顯示（留邊）', fill: '延展'};
const PAUSE_LABELS = {
    maximized: '有視窗最大化或全螢幕時',
    fullscreen: '有視窗全螢幕時',
    never: '永不',
};

// [view id, icon, label]; library views filter what is installed, workshop
// views query Steam.
const LIBRARY_VIEWS = [
    ['all', 'preferences-desktop-wallpaper-symbolic', '全部'],
    ['scene', 'applications-graphics-symbolic', '場景'],
    ['video', 'video-x-generic-symbolic', '影片'],
    ['web', 'web-browser-symbolic', '網頁'],
];
const WORKSHOP_VIEWS = [
    ['trend', 'starred-symbolic', '本週熱門'],
    ['recent', 'document-open-recent-symbolic', '最新上傳'],
    ['top', 'emblem-favorite-symbolic', '最多訂閱'],
];
const SUBSCRIBED_VIEW = ['subscribed', 'emblem-ok-symbolic', '已訂閱'];
const SETTINGS_VIEW = ['settings', 'emblem-system-symbolic', '播放與效能'];
const VIEW_TITLES = {
    all: '全部桌布', scene: '場景桌布', video: '影片桌布', web: '網頁桌布', subscribed: '已訂閱的桌布',
    trend: '工作坊・本週熱門', recent: '工作坊・最新上傳', top: '工作坊・最多訂閱', settings: '播放與效能',
};
// Label → Workshop tag.
const WORKSHOP_TAGS = {
    '動漫': 'Anime', '遊戲': 'Game', '風景': 'Landscape', '賽博龐克': 'Cyberpunk', '動物': 'Animal', '4K': '3840 x 2160',
};

const STYLE = `
.gwe-sidebar { background-color: alpha(currentColor, 0.04); }
.gwe-section-title { font-size: 0.85em; font-weight: 600; opacity: 0.65; margin: 14px 12px 4px; }
.gwe-thumb { border-radius: 12px; }
.gwe-card { padding: 6px; border-radius: 14px; }
.gwe-card:selected { background-color: alpha(@accent_bg_color, 0.28); }
.gwe-badge { background-color: rgba(0, 0, 0, 0.72); color: white; border-radius: 11px; padding: 2px 8px; font-size: 0.85em; font-weight: 600; margin: 8px; }
.gwe-badge.warning { color: #e6b24a; }
.gwe-unsupported picture { opacity: 0.35; }
.gwe-now { background-color: alpha(currentColor, 0.06); border-radius: 12px; padding: 10px; margin: 8px; }
.gwe-hero { border-radius: 12px; }
.gwe-chip { border-radius: 999px; padding: 2px 12px; min-height: 28px; }
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
        return '主題色';
    if (!text && raw.includes('<'))
        return null;
    return text || name;
}

function formatSize(bytes) {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function formatCount(count) {
    return count >= 10000 ? `${(count / 10000).toFixed(1)} 萬` : count.toLocaleString('zh-TW');
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
        model: Gtk.StringList.new(Object.values(labels)),
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
        super({tooltip_text: item.title, css_classes: ['gwe-card']});
        this.item = item;

        this.picture = new Gtk.Picture({
            content_fit: Gtk.ContentFit.COVER,
            height_request: PREVIEW_SIZE,
            css_classes: ['gwe-thumb', 'card'],
            overflow: Gtk.Overflow.HIDDEN,
        });
        this._badge = new Gtk.Label({
            css_classes: ['gwe-badge'], halign: Gtk.Align.START, valign: Gtk.Align.START, visible: false,
        });
        const overlay = new Gtk.Overlay({child: this.picture});
        overlay.add_overlay(this._badge);

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4});
        // The clamp keeps the card at thumbnail width whatever the image size.
        box.append(new Adw.Clamp({maximum_size: PREVIEW_SIZE, child: overlay}));
        box.append(new Gtk.Label({
            label: item.title, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 18, css_classes: ['heading'],
        }));
        box.append(new Gtk.Label({label: meta, css_classes: ['caption', 'dim-label']}));
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
    constructor(window, settings) {
        this._window = window;
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
            settings.connect('changed::paused', () => this._updateNowPlaying()),
            settings.connect('changed::muted', () => this._updateNowPlaying()),
            settings.connect('changed::extra-dirs', () => this._reloadLibrary()));
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
        if (this._batchSourceId)
            GLib.source_remove(this._batchSourceId);
        if (this._searchSourceId)
            GLib.source_remove(this._searchSourceId);
    }

    get _isWorkshopView() {
        return WORKSHOP_VIEWS.some(([id]) => id === this._view);
    }

    // ───────── Layout ─────────

    _buildLayout() {
        const layout = new Gtk.Box();
        layout.append(this._buildSidebar());
        layout.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL}));
        layout.append(this._buildContent());
        layout.append(new Gtk.Separator({orientation: Gtk.Orientation.VERTICAL}));
        layout.append(this._buildDetailPane());
        return layout;
    }

    _buildSidebar() {
        const header = new Adw.HeaderBar({
            show_end_title_buttons: false,
            show_start_title_buttons: false,
            title_widget: new Adw.WindowTitle({title: 'Wallpaper Engine'}),
        });

        this._navRows = new Map();
        const navigation = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        const addSection = (title, views) => {
            navigation.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['gwe-section-title']}));
            const list = new Gtk.ListBox({css_classes: ['navigation-sidebar'], selection_mode: Gtk.SelectionMode.SINGLE});
            for (const [id, icon, label] of views) {
                const count = new Gtk.Label({css_classes: ['dim-label', 'caption', 'numeric']});
                const content = new Gtk.Box({spacing: 10});
                content.append(new Gtk.Image({icon_name: icon}));
                content.append(new Gtk.Label({label, xalign: 0, hexpand: true}));
                content.append(count);
                const row = new Gtk.ListBoxRow({child: content});
                row.viewId = id;
                list.append(row);
                this._navRows.set(id, {row, list, count});
            }
            list.connect('row-activated', (_list, row) => this._showView(row.viewId));
            navigation.append(list);
        };
        addSection('桌布庫', LIBRARY_VIEWS);
        addSection('Steam 工作坊', [...WORKSHOP_VIEWS, SUBSCRIBED_VIEW]);
        addSection('偏好設定', [SETTINGS_VIEW]);

        this._nowPlaying = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, css_classes: ['gwe-now']});

        const body = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        body.append(new Gtk.ScrolledWindow({child: navigation, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER}));
        body.append(this._nowPlaying);

        const view = new Adw.ToolbarView({content: body, width_request: 236, hexpand: false, css_classes: ['gwe-sidebar']});
        view.add_top_bar(header);
        return view;
    }

    _buildContent() {
        this._title = new Adw.WindowTitle();
        this._searchEntry = new Gtk.SearchEntry({placeholder_text: '搜尋桌布', width_request: 240});
        this._searchEntry.connect('search-changed', () => this._onSearchChanged());
        const refreshButton = new Gtk.Button({icon_name: 'view-refresh-symbolic', tooltip_text: '重新整理'});
        refreshButton.connect('clicked', () => {
            if (this._isWorkshopView)
                this._loadWorkshop(true);
            else
                this._reloadLibrary();
        });

        const header = new Adw.HeaderBar({
            show_end_title_buttons: false,
            show_start_title_buttons: false,
            title_widget: this._title,
        });
        header.pack_end(refreshButton);
        header.pack_end(this._searchEntry);

        // Workshop tag filters.
        this._tagBar = new Gtk.Box({spacing: 8, margin_start: 20, margin_end: 20, margin_top: 12});
        for (const [label, tag] of Object.entries(WORKSHOP_TAGS)) {
            const chip = new Gtk.ToggleButton({label, css_classes: ['gwe-chip']});
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

        this._sceneNotice = new Adw.Banner({
            title: '場景桌布需要場景渲染器：請先在終端機執行一次 gnome-wallpaper-engine-setup-scene（原始碼安裝則是 setup-scene-renderer.sh）。',
        });

        this._flowBox = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            activate_on_single_click: false,
            homogeneous: true,
            valign: Gtk.Align.START,
            min_children_per_line: 2,
            max_children_per_line: 12,
            column_spacing: 4,
            row_spacing: 8,
            margin_start: 14, margin_end: 14, margin_top: 12, margin_bottom: 12,
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
                this._settings.set_string('wallpaper', card.item.dir);
        });

        this._moreButton = new Gtk.Button({
            label: '載入更多', halign: Gtk.Align.CENTER, css_classes: ['pill'], margin_bottom: 24, visible: false,
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
            orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_start: 20, margin_end: 20, margin_top: 4, margin_bottom: 20,
        });
        const header = new Adw.HeaderBar({title_widget: new Adw.WindowTitle({title: '詳細資訊'})});
        this._detailPane = new Adw.ToolbarView({
            content: new Gtk.ScrolledWindow({child: this._detailBox, hscrollbar_policy: Gtk.PolicyType.NEVER}),
            width_request: 348,
            hexpand: false,
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
        this._title.title = VIEW_TITLES[view];
        this._title.subtitle = '';
        this._tagBar.visible = this._isWorkshopView;
        this._searchEntry.visible = view !== 'settings';
        this._searchEntry.placeholder_text = this._isWorkshopView ? '搜尋工作坊' : '搜尋桌布';
        this._moreButton.visible = false;

        if (view === 'settings') {
            this._stack.visible_child_name = 'settings';
            this._clearDetails('調整播放、音量與暫停時機。');
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

        this._sceneNotice.revealed = countOf('scene') > 0 &&
            !findSceneRenderer(this._settings.get_string('scene-renderer'));
        this._updateNowPlaying();
        // Workshop views don't show the library, but their "subscribed" state depends on it.
        if (this._isWorkshopView)
            this._refreshBadges();
        else if (this._view !== 'settings')
            this._showView(this._view);
    }

    _populateLibrary() {
        const current = this._settings.get_string('wallpaper');
        const projects = this._projects
            .filter(project => this._view === 'all' ||
                (this._view === 'subscribed' ? project.workshopId : project.type === this._view))
            // The active wallpaper comes first so it is visible right away.
            .sort((a, b) => (b.dir === current) - (a.dir === current));

        this._title.subtitle = `${projects.length} 張`;
        if (projects.length === 0) {
            this._showStatus({
                icon: 'preferences-desktop-wallpaper-symbolic',
                title: '這裡還沒有桌布',
                description: '在 Steam 安裝 Wallpaper Engine，然後到工作坊訂閱桌布；Steam 下載完成後會出現在這裡。',
                action: ['安裝 Wallpaper Engine', () => Gio.AppInfo.launch_default_for_uri(STEAM_INSTALL_URI, null)],
            });
            this._clearDetails('選一張桌布來查看詳細資訊。');
            return;
        }
        this._fillGrid(projects.map(project => () => {
            const card = new WallpaperCard(project, TYPE_LABELS[project.type]);
            card.picture.set_paintable(loadPreviewTexture(project.preview));
            if (!isSceneSupported(project))
                card.add_css_class('gwe-unsupported');
            return card;
        }), true);
    }

    // ───────── Workshop ─────────

    async _loadWorkshop(reset) {
        if (reset) {
            this._workshopPage = 1;
            this._stack.visible_child_name = 'loading';
            this._clearDetails('選一張桌布來查看詳細資訊。');
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
                title: '無法載入工作坊',
                description: e.message,
                action: ['重試', () => this._loadWorkshop(true)],
            });
            return;
        }
        // A newer request (other view, search or tag) superseded this one.
        if (this._workshopRequest !== request)
            return;

        if (reset && results.length === 0) {
            this._showStatus({icon: 'edit-find-symbolic', title: '找不到符合的桌布', description: '換個關鍵字或標籤試試。'});
            return;
        }
        this._fillGrid(results.map(result => () => {
            const card = new WallpaperCard(result, `${TYPE_LABELS[result.type]} · ${formatCount(result.subscriptions)} 人訂閱`);
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
        const current = this._settings.get_string('wallpaper');
        for (let card = this._flowBox.get_first_child(); card; card = card.get_next_sibling()) {
            const project = this._libraryProjectFor(card.item);
            if (project?.dir === current)
                card.setBadge('● 使用中');
            else if (project && !isSceneSupported(project))
                card.setBadge('無法顯示', true);
            else if (project && !card.item.dir)
                card.setBadge('已訂閱');
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
        this._replaceDetails([new Adw.StatusPage({description: message, vexpand: true})]);
    }

    _replaceDetails(widgets) {
        for (let child = this._detailBox.get_first_child(); child; child = this._detailBox.get_first_child())
            this._detailBox.remove(child);
        widgets.forEach(widget => this._detailBox.append(widget));
    }

    _showDetails(item) {
        this._selected = item;
        const project = this._libraryProjectFor(item);
        const current = this._settings.get_string('wallpaper');

        const hero = new Gtk.Picture({
            content_fit: Gtk.ContentFit.COVER, height_request: 308, css_classes: ['gwe-hero', 'card'],
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

        if (item.dir)
            addCaption(`${TYPE_LABELS[item.type]} · ${item.workshopId ? 'Steam 工作坊' : '本機桌布'}`);
        else
            addCaption(`${'★'.repeat(item.stars)}${'☆'.repeat(5 - item.stars)}　${item.votes} 則評價`);

        // The one primary action of the pane.
        if (project && !isSceneSupported(project)) {
            widgets.push(pill('無法套用', [], null));
            addCaption('這張場景使用 3D 透視攝影機，目前的場景渲染器還無法顯示。', ['warning']);
        } else if (project?.dir === current) {
            widgets.push(pill('✓ 使用中', [], null));
            widgets.push(pill('停止桌布', [], () => this._settings.set_string('wallpaper', '')));
        } else if (project) {
            widgets.push(pill('套用桌布', ['suggested-action'], () => this._settings.set_string('wallpaper', project.dir)));
        } else {
            widgets.push(pill(`在 Steam 訂閱（${formatSize(item.size)}）`, ['suggested-action'], () => {
                Gio.AppInfo.launch_default_for_uri(Workshop.steamPageUri(item.id), null);
                this._toastOverlay.add_toast(new Adw.Toast({title: '已在 Steam 開啟這張桌布，按下「訂閱」後會自動下載。'}));
            }));
            addCaption('訂閱會透過你的 Steam 帳號進行；下載完成後自動出現在桌布庫。', ['dim-label', 'caption']);
        }
        const workshopId = item.dir ? item.workshopId : item.id;
        if (workshopId && project) {
            widgets.push(pill('在 Steam 開啟工作坊頁面', [], () =>
                Gio.AppInfo.launch_default_for_uri(Workshop.steamPageUri(workshopId), null)));
        }

        if (!item.dir) {
            const info = new Adw.PreferencesGroup({title: '作品資訊'});
            for (const [title, value] of [
                ['訂閱', `${formatCount(item.subscriptions)} 人`],
                ['收藏', `${formatCount(item.favorited)} 人`],
                ['更新日期', GLib.DateTime.new_from_unix_local(item.updated).format('%Y 年 %-m 月 %-d 日')],
                ['標籤', item.tags.join('、')],
            ]) {
                const row = new Adw.ActionRow({title, subtitle: GLib.markup_escape_text(value, -1), css_classes: ['property']});
                info.add(row);
            }
            widgets.push(info);
            if (item.description) {
                const description = new Adw.PreferencesGroup({title: '作者說明'});
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
        const rows = Object.entries(project.properties)
            .sort(([, a], [, b]) => (a.order ?? 0) - (b.order ?? 0))
            .map(([name, definition]) => this._createPropertyRow(project.dir, name, definition))
            .filter(row => row !== null);
        if (rows.length === 0)
            return null;

        const group = new Adw.PreferencesGroup({title: '自訂選項', description: `${rows.length} 項`});
        rows.forEach((row, index) => {
            row.visible = index < COLLAPSED_PROPERTIES;
            group.add(row);
        });
        if (rows.length > COLLAPSED_PROPERTIES) {
            const showAll = new Adw.ButtonRow({title: `顯示全部 ${rows.length} 項`});
            showAll.connect('activated', () => {
                rows.forEach(row => (row.visible = true));
                showAll.visible = false;
            });
            group.add(showAll);
        }
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
            this._nowPlaying.append(new Gtk.Label({label: '未套用動態桌布', xalign: 0, css_classes: ['dim-label']}));
            return;
        }
        const paused = this._settings.get_boolean('paused');
        const muted = this._settings.get_boolean('muted');

        this._nowPlaying.append(new Gtk.Label({
            label: paused ? '已暫停' : '播放中', xalign: 0, css_classes: ['caption', paused ? 'warning' : 'success'],
        }));
        const info = new Gtk.Box({spacing: 10});
        const thumbnail = new Gtk.Picture({
            content_fit: Gtk.ContentFit.COVER, width_request: 44, height_request: 44,
            css_classes: ['gwe-thumb'], overflow: Gtk.Overflow.HIDDEN, can_shrink: true,
            paintable: loadPreviewTexture(project.preview),
        });
        info.append(new Adw.Clamp({maximum_size: 44, child: thumbnail}));
        info.append(new Gtk.Label({label: project.title, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END, css_classes: ['heading']}));
        this._nowPlaying.append(info);

        const controls = new Gtk.Box({spacing: 6, homogeneous: true});
        const control = (icon, tooltip, onClicked) => {
            const button = new Gtk.Button({icon_name: icon, tooltip_text: tooltip});
            button.connect('clicked', onClicked);
            controls.append(button);
        };
        control(paused ? 'media-playback-start-symbolic' : 'media-playback-pause-symbolic', paused ? '繼續播放' : '暫停',
            () => this._settings.set_boolean('paused', !paused));
        control(muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic', muted ? '取消靜音' : '靜音',
            () => this._settings.set_boolean('muted', !muted));
        control('media-playback-stop-symbolic', '停止桌布', () => this._settings.set_string('wallpaper', ''));
        this._nowPlaying.append(controls);
    }

    // ───────── Settings ─────────

    _buildSettingsPage() {
        const settings = this._settings;
        const page = new Adw.PreferencesPage();

        const playback = new Adw.PreferencesGroup({title: '播放'});
        page.add(playback);

        const mutedRow = new Adw.SwitchRow({title: '桌布靜音'});
        settings.bind('muted', mutedRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        playback.add(mutedRow);

        const volumeRow = new Adw.SpinRow({
            title: '音量',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5}),
        });
        settings.bind('volume', volumeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        playback.add(volumeRow);

        playback.add(createChoiceRow(settings, 'fit', '縮放方式', FIT_LABELS));
        playback.add(createChoiceRow(settings, 'pause-mode', '自動暫停', PAUSE_LABELS));

        const folders = new Adw.PreferencesGroup({
            title: '其他桌布資料夾',
            description: '資料夾內每個子資料夾是一張桌布（含 project.json）。Steam 收藏庫會自動找到，不必加入。',
        });
        page.add(folders);

        const addButton = new Gtk.Button({icon_name: 'list-add-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: '加入資料夾'});
        addButton.connect('clicked', () => {
            new Gtk.FileDialog({title: '選擇桌布資料夾'}).select_folder(this._window, null, (dialog, result) => {
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
                const removeButton = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat'], valign: Gtk.Align.CENTER, tooltip_text: '移除'});
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

export default class WallpaperEnginePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_title('Wallpaper Engine');
        window.set_default_size(1280, 820);
        window.set_search_enabled(false);
        new Picker(window, this.getSettings());
    }
}
