// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the daemon learns about the session, none of which tells anyone when
// it changes: Nekoland's displays, windows and wallpaper through `nekoland msg`,
// and the sound streams through pw-dump.

import Gio from 'gi://Gio';

/** Runs a program; resolves to what it printed, rejects when it fails. */
export function run(argv) {
    return new Promise((resolve, reject) => {
        const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        process.communicate_utf8_async(null, null, (_process, result) => {
            try {
                const [, stdout, stderr] = process.communicate_utf8_finish(result);
                if (process.get_successful())
                    resolve(stdout);
                else
                    reject(new Error(`${argv.join(' ')}: ${stderr.trim()}`));
            } catch (e) {
                reject(e);
            }
        });
    });
}

export function nekolandMsg(message) {
    return run(['nekoland', 'msg', message]);
}

/**
 * Nekoland's `displays`, one a line: name, WIDTHxHEIGHT, X, Y and on|off, tab
 * between, in points. The displays that are on, the main one first.
 */
export function parseDisplays(text) {
    return text.split('\n')
        .map(line => line.split('\t'))
        .filter(fields => fields.length === 5 && fields[4] === 'on')
        .map(([name, size, x, y]) => {
            const [width, height] = size.split('x').map(Number);
            return {name, x: Number(x), y: Number(y), width, height};
        });
}

/** Nekoland's `window-areas`, the windows on screen: `X Y WIDTH HEIGHT`, a tab and the title. */
export function parseWindowAreas(text) {
    return text.split('\n').filter(line => line.includes('\t')).map(line => {
        const [area, ...title] = line.split('\t');
        const [x, y, width, height] = area.split(' ').map(Number);
        return {x, y, width, height, title: title.join('\t')};
    });
}

/** Whether every display has a window over at least `share` of it. */
export function isEveryDisplayCovered(displays, windows, share) {
    const overlap = (a, b) =>
        Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    return displays.length > 0 && displays.every(display =>
        windows.some(window => overlap(display, window) >= share * display.width * display.height));
}

/** The path `nekoland msg config` gives as the wallpaper, or '' for none. */
export function parseConfigWallpaper(text) {
    const line = text.match(/^wallpaper = (".*")$/m);
    // A TOML basic string with nothing unusual in it reads the same as JSON.
    return line ? JSON.parse(line[1]) : '';
}

/**
 * Whether pw-dump's objects include a sound stream that is playing and not
 * muted, other than those of the processes `ownPids` or the programs `ownNames`.
 */
export function isOtherAudioPlaying(objects, ownPids, ownNames) {
    return objects.some(({type, info}) => {
        const props = info?.props ?? {};
        return type === 'PipeWire:Interface:Node' &&
            props['media.class'] === 'Stream/Output/Audio' &&
            info.state === 'running' &&
            !info.params?.Props?.[0]?.mute &&
            !ownPids.includes(Number(props['application.process.id'])) &&
            !ownNames.includes(props['application.name']);
    });
}
