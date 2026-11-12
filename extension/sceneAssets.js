// SPDX-License-Identifier: GPL-3.0-or-later
//
// Downloading the scene assets without installing Wallpaper Engine: SteamCMD
// fetches the Windows app's content depot and only its `assets` folder is
// kept. Steam itself checks that the account owns Wallpaper Engine.
//
// SteamCMD runs with a private HOME, so it never touches the Steam client's
// files, and under script(1), because its password and Steam Guard prompts
// expect a terminal.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import {LOCAL_ASSETS_DIR, WALLPAPER_ENGINE_APP_ID} from './library.js';

const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz';
const STEAMCMD_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-paper-engine', 'steamcmd']);
const STEAMCMD_SCRIPT = GLib.build_filenamev([STEAMCMD_DIR, 'steamcmd.sh']);
// Wallpaper Engine's Windows content depot, about 800 MB; the assets are about 100 MB of it.
const CONTENT_DEPOT_ID = '431961';
// Where SteamCMD puts the depot when its output does not say.
const DEFAULT_DEPOT_DIR = GLib.build_filenamev([
    STEAMCMD_DIR, 'linux32', 'steamapps', 'content', `app_${WALLPAPER_ENGINE_APP_ID}`, `depot_${CONTENT_DEPOT_ID}`]);

const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;
// Kept at module level: a session collected mid-request never calls back.
const session = new Soup.Session({timeout: 60});

/**
 * What a line of SteamCMD output means here: {prompt: 'password' | 'code'},
 * {status: 'confirm' | 'downloading'}, {depotDir}, {failure: 'sign-in' |
 * 'rate-limit' | 'not-owned'}, or null. Prompts arrive without a line break,
 * so this is also asked about the unfinished last line.
 */
export function readSteamCmdLine(line) {
    const text = line.replace(ANSI_ESCAPE, '').trim();
    const lower = text.toLowerCase();
    if (lower.endsWith('password:'))
        return {prompt: 'password'};
    // "Steam Guard code:" (email) or "Two-factor code:" (authenticator).
    if (lower.endsWith('code:'))
        return {prompt: 'code'};
    if (lower.includes('confirm') && lower.includes('mobile'))
        return {status: 'confirm'};
    const complete = text.match(/^Depot download complete : "([^"]+)"/i);
    if (complete)
        return {depotDir: complete[1]};
    if (lower.includes('logged in ok') || lower.startsWith('downloading depot'))
        return {status: 'downloading'};
    if (/invalid password|invalid login|account logon denied/.test(lower))
        return {failure: 'sign-in'};
    if (lower.includes('rate limit'))
        return {failure: 'rate-limit'};
    if (/no subscription|does not own|access denied/.test(lower))
        return {failure: 'not-owned'};
    return null;
}

function runCommand(argv, cancellable) {
    const subprocess = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_MERGE);
    return new Promise((resolve, reject) => {
        subprocess.wait_check_async(cancellable, (_subprocess, result) => {
            try {
                resolve(subprocess.wait_check_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// How many bytes at the end of `bytes` start a UTF-8 character that the next chunk completes.
function incompleteTailLength(bytes) {
    for (let i = 1; i <= Math.min(3, bytes.length); i++) {
        const byte = bytes[bytes.length - i];
        if ((byte & 0xc0) !== 0x80) {
            const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
            return length > i ? i : 0;
        }
    }
    return 0;
}

function readChunk(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_bytes_async(8192, GLib.PRIORITY_DEFAULT, cancellable, (_stream, result) => {
            try {
                resolve(stream.read_bytes_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

async function installSteamCmd(cancellable) {
    const message = Soup.Message.new('GET', STEAMCMD_URL);
    const bytes = await new Promise((resolve, reject) => {
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
            try {
                resolve(session.send_and_read_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
    if (message.get_status() !== Soup.Status.OK)
        throw new Error(`Downloading SteamCMD failed: ${message.get_status()} ${message.get_reason_phrase()}`);
    GLib.mkdir_with_parents(STEAMCMD_DIR, 0o755);
    const archive = GLib.build_filenamev([STEAMCMD_DIR, 'steamcmd_linux.tar.gz']);
    GLib.file_set_contents(archive, bytes.toArray());
    await runCommand(['tar', '-xzf', archive, '-C', STEAMCMD_DIR], cancellable);
    GLib.unlink(archive);
}

/**
 * Signs in with SteamCMD and downloads the content depot. `ask(kind)` gets the
 * answer to a 'password' or 'code' prompt, or null to give up. Resolves to
 * the depot folder and the last failure Steam reported.
 */
async function downloadDepot({account, ask, onStatus, record, cancellable}) {
    const home = GLib.build_filenamev([STEAMCMD_DIR, 'home']);
    GLib.mkdir_with_parents(home, 0o700);
    const command = [
        STEAMCMD_SCRIPT, '+@ShutdownOnFailedCommand', '1', '+@sSteamCmdForcePlatformType', 'windows',
        '+login', account, '+download_depot', WALLPAPER_ENGINE_APP_ID, CONTENT_DEPOT_ID, '+quit',
    ].map(argument => GLib.shell_quote(argument)).join(' ');
    const launcher = new Gio.SubprocessLauncher({
        flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
    });
    launcher.setenv('HOME', home, true);
    launcher.setenv('SHELL', '/bin/sh', true);
    launcher.setenv('TERM', 'dumb', true);
    const subprocess = launcher.spawnv(['script', '--quiet', '--return', '--command', command, '/dev/null']);
    const stdin = subprocess.get_stdin_pipe();
    const stdout = subprocess.get_stdout_pipe();

    let depotDir = null;
    let failure = null;
    const handle = async line => {
        const meaning = readSteamCmdLine(line);
        if (meaning?.prompt) {
            const answer = await ask(meaning.prompt);
            if (answer === null)
                throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED, 'Sign-in cancelled');
            record.secrets.push(answer);
            stdin.write_all(new TextEncoder().encode(`${answer}\n`), null);
        } else if (meaning?.status) {
            onStatus(meaning.status);
        }
        depotDir = meaning?.depotDir ?? depotDir;
        failure = meaning?.failure ?? failure;
    };

    const decoder = new TextDecoder();
    let carried = new Uint8Array();
    let pending = '';
    try {
        for (;;) {
            const bytes = await readChunk(stdout, cancellable);
            if (bytes.get_size() === 0)
                break;
            const chunk = new Uint8Array([...carried, ...bytes.toArray()]);
            const complete = chunk.length - incompleteTailLength(chunk);
            carried = chunk.slice(complete);
            pending += decoder.decode(chunk.subarray(0, complete));
            const lines = pending.split(/\r\n|\r|\n/);
            pending = lines.pop();
            for (const line of lines) {
                record.line(line);
                await handle(line);
            }
            if (readSteamCmdLine(pending)?.prompt) {
                const prompt = pending;
                pending = '';
                record.line(prompt);
                await handle(prompt);
            }
        }
        await new Promise((resolve, reject) => {
            subprocess.wait_async(cancellable, (_subprocess, result) => {
                try {
                    resolve(subprocess.wait_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
    } catch (e) {
        subprocess.force_exit();
        throw e;
    }
    return {depotDir, failure};
}

/**
 * Downloads Wallpaper Engine's content depot as `account` and installs its
 * `assets` folder at LOCAL_ASSETS_DIR. `onStatus` hears 'steamcmd',
 * 'signing-in', 'confirm', 'downloading' and 'installing'. What SteamCMD
 * prints goes to `log`, with the answers to its prompts masked. A failure
 * Steam explained carries it as `reason`.
 */
export async function downloadSceneAssets({account, ask, onStatus, log, cancellable = null}) {
    const output = [];
    const record = {
        secrets: [],
        line(text) {
            const plain = text.replace(ANSI_ESCAPE, '');
            output.push(this.secrets.reduce((masked, secret) => masked.replaceAll(secret, '********'), plain));
        },
    };
    try {
        if (!GLib.file_test(STEAMCMD_SCRIPT, GLib.FileTest.IS_EXECUTABLE)) {
            onStatus('steamcmd');
            await installSteamCmd(cancellable);
        }
        onStatus('signing-in');
        const {depotDir, failure} = await downloadDepot({account, ask, onStatus, record, cancellable});

        const depot = depotDir ?? DEFAULT_DEPOT_DIR;
        const assets = GLib.build_filenamev([depot, 'assets']);
        if (!GLib.file_test(assets, GLib.FileTest.IS_DIR)) {
            const error = new Error(`SteamCMD did not download the assets folder (${failure ?? 'no reason given'})`);
            error.reason = failure;
            throw error;
        }

        onStatus('installing');
        const staging = `${LOCAL_ASSETS_DIR}.partial`;
        GLib.mkdir_with_parents(GLib.path_get_dirname(LOCAL_ASSETS_DIR), 0o755);
        await runCommand(['rm', '-rf', staging], cancellable);
        await runCommand(['cp', '-r', assets, staging], cancellable);
        await runCommand(['rm', '-rf', LOCAL_ASSETS_DIR], cancellable);
        await runCommand(['mv', '-T', staging, LOCAL_ASSETS_DIR], cancellable);
        // The rest of the depot is the Windows app: only delete it from SteamCMD's own folder.
        if (GLib.canonicalize_filename(depot, null).startsWith(`${STEAMCMD_DIR}/`))
            await runCommand(['rm', '-rf', depot], cancellable);
    } catch (e) {
        output.push(e.message);
        throw e;
    } finally {
        GLib.mkdir_with_parents(GLib.path_get_dirname(log), 0o755);
        GLib.file_set_contents(log, `${output.join('\n')}\n`);
    }
}
