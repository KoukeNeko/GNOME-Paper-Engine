// SPDX-License-Identifier: GPL-3.0-or-later
//
// Locating and reading Wallpaper Engine projects. Shared by the shell
// extension and the preferences window, so it only depends on GLib/Gio.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const WALLPAPER_ENGINE_APP_ID = '431960';

// Where a Steam installation may live, relative to the home directory.
const STEAM_ROOTS = [
    '.local/share/Steam',
    '.steam/steam',
    'snap/steam/common/.local/share/Steam',
    '.var/app/com.valvesoftware.Steam/.local/share/Steam',
];

// Where setup-scene-renderer.sh installs linux-wallpaperengine.
const LOCAL_SCENE_RENDERER = GLib.build_filenamev(
    [GLib.get_user_data_dir(), 'gnome-paper-engine', 'bin', 'linux-wallpaperengine']);
// The checksum of the patches that renderer was built with, written by the setup script.
const LOCAL_SCENE_RENDERER_PATCHES = GLib.build_filenamev(
    [GLib.get_user_data_dir(), 'gnome-paper-engine', 'linux-wallpaperengine', 'patches.sha256']);
// Where the picker installs the scene assets it downloads with SteamCMD.
export const LOCAL_ASSETS_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-paper-engine', 'assets']);

const BLUR_MY_SHELL_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell';
const BLUR_MY_SHELL_SCHEMA_DIRS = [
    GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell/extensions/blur-my-shell@aunetx/schemas']),
    '/usr/share/gnome-shell/extensions/blur-my-shell@aunetx/schemas',
];
// Blur my Shell components whose blur can include the windows behind them.
export const BLUR_MY_SHELL_COMPONENTS = ['dash-to-dock', 'panel'];

/**
 * Blur my Shell's settings for one of BLUR_MY_SHELL_COMPONENTS, or null when
 * Blur my Shell is not installed or the component has no `static-blur` key.
 * A static blur is the one that leaves the windows out.
 */
export function blurMyShellSettings(component) {
    const dir = BLUR_MY_SHELL_SCHEMA_DIRS.find(candidate =>
        GLib.file_test(GLib.build_filenamev([candidate, 'gschemas.compiled']), GLib.FileTest.EXISTS));
    if (!dir)
        return null;
    const schema = Gio.SettingsSchemaSource.new_from_directory(dir, null, false)
        .lookup(`${BLUR_MY_SHELL_SCHEMA}.${component}`, false);
    return schema?.has_key('static-blur') ? new Gio.Settings({settings_schema: schema}) : null;
}

/** Fills the %s placeholders of a translated string, in order. */
export function format(template, ...values) {
    return values.reduce((text, value) => text.replace('%s', value), template);
}

function readTextFile(path) {
    try {
        const [, bytes] = GLib.file_get_contents(path);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        if (e.matches(GLib.FileError, GLib.FileError.NOENT))
            return null;
        throw e;
    }
}

function listSubdirectories(path) {
    const directory = Gio.File.new_for_path(path);
    let children;
    try {
        children = directory.enumerate_children(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    } catch (e) {
        if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND) ||
            e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_DIRECTORY))
            return [];
        throw e;
    }
    const result = [];
    let info;
    while ((info = children.next_file(null))) {
        if (info.get_file_type() === Gio.FileType.DIRECTORY)
            result.push(GLib.build_filenamev([path, info.get_name()]));
    }
    return result;
}

/** Steam library folders (each containing a `steamapps` directory), deduplicated. */
export function findSteamLibraries() {
    const libraries = new Set();
    for (const root of STEAM_ROOTS) {
        const steamDir = GLib.build_filenamev([GLib.get_home_dir(), root]);
        const vdf = readTextFile(GLib.build_filenamev([steamDir, 'steamapps', 'libraryfolders.vdf']));
        if (vdf === null)
            continue;
        libraries.add(GLib.canonicalize_filename(steamDir, null));
        for (const [, path] of vdf.matchAll(/"path"\s+"([^"]+)"/g))
            libraries.add(GLib.canonicalize_filename(path.replaceAll('\\\\', '/'), null));
    }
    // ~/.steam/steam is usually a symlink to one of the other roots.
    const resolved = new Set();
    for (const library of libraries) {
        resolved.add(GLib.file_test(library, GLib.FileTest.IS_SYMLINK)
            ? GLib.canonicalize_filename(GLib.file_read_link(library), GLib.path_get_dirname(library))
            : library);
    }
    return [...resolved];
}

/**
 * The `assets` directory needed to render scenes: that of a Wallpaper Engine
 * install, or the one downloaded from the picker.
 */
export function findAssetsDir() {
    for (const library of findSteamLibraries()) {
        const assets = GLib.build_filenamev([library, 'steamapps', 'common', 'wallpaper_engine', 'assets']);
        if (GLib.file_test(assets, GLib.FileTest.IS_DIR))
            return assets;
    }
    return GLib.file_test(LOCAL_ASSETS_DIR, GLib.FileTest.IS_DIR) ? LOCAL_ASSETS_DIR : null;
}

/**
 * Reads `<dir>/project.json`. Returns null when the directory is not a
 * wallpaper project we can show (missing or malformed manifest, presets, …).
 */
export function loadProject(dir) {
    const text = readTextFile(GLib.build_filenamev([dir, 'project.json']));
    if (text === null)
        return null;
    let manifest;
    try {
        manifest = JSON.parse(text);
    } catch (e) {
        console.warn(`Ignoring ${dir}: invalid project.json (${e.message})`);
        return null;
    }
    if (typeof manifest.type !== 'string' || typeof manifest.file !== 'string')
        return null;
    const parent = GLib.path_get_dirname(dir);
    return {
        dir,
        // Set for wallpapers that Steam downloaded from the Workshop.
        workshopId: GLib.path_get_basename(parent) === WALLPAPER_ENGINE_APP_ID ? GLib.path_get_basename(dir) : null,
        title: manifest.title || GLib.path_get_basename(dir),
        type: manifest.type.toLowerCase(),
        file: GLib.build_filenamev([dir, manifest.file]),
        preview: manifest.preview ? GLib.build_filenamev([dir, manifest.preview]) : null,
        // {name: {type, text, value, min, max, options, …}}
        properties: manifest.general?.properties ?? {},
    };
}

/** Where Steam puts downloaded Workshop wallpapers, one directory per library. */
export function findWorkshopDirs() {
    return findSteamLibraries().map(library =>
        GLib.build_filenamev([library, 'steamapps', 'workshop', 'content', WALLPAPER_ENGINE_APP_ID]));
}

/**
 * False for scenes the scene renderer is known not to open: those using a
 * perspective camera. Only unpacked scenes can be checked; packaged ones
 * (scene.pkg) are assumed to work.
 */
export function isSceneSupported(project) {
    // Asked for every card of the picker, over and over: read the scene once.
    project.sceneSupported ??= readSceneSupported(project);
    return project.sceneSupported;
}

function readSceneSupported(project) {
    if (project.type !== 'scene')
        return true;
    let text;
    try {
        text = readTextFile(project.file);
    } catch (e) {
        return true;
    }
    if (text === null)
        return true;
    try {
        return JSON.parse(text).general?.orthogonalprojection != null;
    } catch (e) {
        return true;
    }
}

/** All wallpaper projects found in the Steam libraries and `extraDirs`. */
export function listProjects(extraDirs = []) {
    const containers = [...extraDirs, ...findWorkshopDirs()];
    for (const library of findSteamLibraries()) {
        const steamapps = GLib.build_filenamev([library, 'steamapps']);
        const projects = GLib.build_filenamev([steamapps, 'common', 'wallpaper_engine', 'projects']);
        containers.push(
            GLib.build_filenamev([projects, 'myprojects']),
            GLib.build_filenamev([projects, 'defaultprojects']));
    }
    return containers
        .flatMap(listSubdirectories)
        .map(loadProject)
        .filter(project => project !== null)
        .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Property values to hand to a wallpaper: the project's defaults with the
 * user's overrides (`{name: value}`) applied.
 */
export function resolveProperties(project, overrides = {}) {
    const resolved = {};
    for (const [name, definition] of Object.entries(project.properties)) {
        if (definition && 'value' in definition)
            resolved[name] = name in overrides ? overrides[name] : definition.value;
    }
    return resolved;
}

/** Path of the linux-wallpaperengine binary, or null when it isn't installed. */
export function findSceneRenderer(configuredPath) {
    if (configuredPath)
        return GLib.file_test(configuredPath, GLib.FileTest.IS_EXECUTABLE) ? configuredPath : null;
    if (GLib.file_test(LOCAL_SCENE_RENDERER, GLib.FileTest.IS_EXECUTABLE))
        return LOCAL_SCENE_RENDERER;
    return GLib.find_program_in_path('linux-wallpaperengine');
}

/**
 * Whether the scene renderer built by the setup script at `setupScript` was
 * built with other patches than the ones next to that script, so it lacks
 * what the extension now asks of it. Renderers built some other way are
 * never reported.
 */
export function isSceneRendererOutdated(configuredPath, setupScript) {
    if (!setupScript || findSceneRenderer(configuredPath) !== LOCAL_SCENE_RENDERER)
        return false;
    // Hashed the way the setup script does: all patches in name order, as one stream.
    const patchesDir = Gio.File.new_for_path(GLib.path_get_dirname(setupScript)).get_child('patches');
    const names = [];
    const enumerator = patchesDir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    for (let info; (info = enumerator.next_file(null));) {
        if (info.get_name().endsWith('.patch'))
            names.push(info.get_name());
    }
    const checksum = new GLib.Checksum(GLib.ChecksumType.SHA256);
    for (const name of names.sort())
        checksum.update(patchesDir.get_child(name).load_contents(null)[1]);
    let built = '';
    try {
        built = new TextDecoder().decode(GLib.file_get_contents(LOCAL_SCENE_RENDERER_PATCHES)[1]).trim();
    } catch (e) {
        // Missing when built before the setup script recorded its patches.
        if (!e.matches(GLib.FileError, GLib.FileError.NOENT))
            throw e;
    }
    return built !== checksum.get_string();
}
