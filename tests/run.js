// SPDX-License-Identifier: GPL-3.0-or-later
//
// Tests for the parsers that read content from outside: option conditions
// from wallpapers, the Workshop browse page and SteamCMD's output; and for
// telling when the scene renderer needs rebuilding. Run with `gjs -m tests/run.js`.

import GLib from 'gi://GLib';
import System from 'system';

// Keep the Workshop module's HTTP cache and the scene renderer files out of the user's own.
GLib.setenv('XDG_CACHE_HOME', GLib.dir_make_tmp('gnome-paper-engine-tests-XXXXXX'), true);
GLib.setenv('XDG_DATA_HOME', GLib.dir_make_tmp('gnome-paper-engine-tests-XXXXXX'), true);

const {evaluateCondition} = await import('../extension/conditions.js');
const {parseBrowsePage} = await import('../extension/workshop.js');
const {readSteamCmdLine, readSavedAccounts} = await import('../extension/sceneAssets.js');
const {isSceneRendererOutdated} = await import('../extension/library.js');

let failures = 0;
function check(name, actual, expected) {
    if (JSON.stringify(actual) === JSON.stringify(expected))
        return;
    failures++;
    printerr(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const values = {mode: 2, simple: false, name: 'Clock', label: '2'};
for (const [condition, expected] of [
    ['mode.value == 2', true],
    ['mode.value == 3', false],
    ['mode.value != 3 && !simple.value', true],
    ['simple.value || mode.value >= 2', true],
    ['(simple.value || mode.value < 2) && mode.value == 2', false],
    // Loose and strict equality differ the way they do in JavaScript.
    ['label.value == 2', true],
    ['label.value === 2', false],
    // A lone = is what some wallpapers write for ==.
    ['mode.value = 2', true],
    ["name.value.startsWith('Cl')", true],
    ['name.value.includes("x")', false],
    // What cannot be understood must never hide an option.
    ['missing.value == 1', true],
    ['mode.value == ', true],
    ['alert(1)', true],
    ['mode.constructor', true],
]) check(`condition ${condition}`, evaluateCondition(condition, values), expected);

// The page embeds its results as JSON inside a JavaScript string literal.
const results = [{
    publishedfileid: '123', title: 'A "quoted" title', preview_url: 'https://example.invalid/p.jpg',
    short_description: 'line one\\nline two', file_size: '2048', subscriptions: 7, favorited: 3,
    star_rating: 4, total_votes: 9, time_updated: 1700000000,
    tags: [{tag: 'Video', display_name: 'Video'}, {tag: 'Wallpaper', display_name: 'Wallpaper'}],
}];
const embedded = JSON.stringify(JSON.stringify({results, total: 1})).slice(1, -1);
const [item] = parseBrowsePage(`<html><script>var data = "${embedded}";</script></html>`);
check('workshop id', item.id, '123');
check('workshop title', item.title, 'A "quoted" title');
check('workshop type', item.type, 'video');
check('workshop size', item.size, 2048);
check('workshop tags', item.tags, ['Video']);
check('workshop description', item.description, 'line one line two');

let threw = false;
try {
    parseBrowsePage('<html>nothing here</html>');
} catch (e) {
    threw = true;
}
check('workshop page without results throws', threw, true);

for (const [line, expected] of [
    ['\x1b[0mpassword: \x1b[0m', {prompt: 'password'}],
    ['Steam Guard code:', {prompt: 'code'}],
    ['Two-factor code:', {prompt: 'code'}],
    ['Please confirm the login in the Steam Mobile app on your phone.', {status: 'confirm'}],
    ['Waiting for user info...OK', null],
    ['Logged in OK', {status: 'downloading'}],
    ['Depot download complete : "/x/steamapps/content/app_431960/depot_431961" (241 files, manifest 1)',
        {depotDir: '/x/steamapps/content/app_431960/depot_431961'}],
    // As printed when SteamCMD is told to act as the Windows client.
    ['Depot download complete : "/x/linux32\\steamapps\\content\\app_431960\\depot_431961" (manifest 5060075082323178717) ',
        {depotDir: '/x/linux32/steamapps/content/app_431960/depot_431961'}],
    ['ERROR (Invalid Password)', {failure: 'sign-in'}],
    ['FAILED (Rate Limit Exceeded)', {failure: 'rate-limit'}],
    ['Depot download failed : No subscription', {failure: 'not-owned'}],
    ['Loading Steam API...OK', null],
]) check(`steamcmd ${JSON.stringify(line)}`, readSteamCmdLine(line), expected);

// SteamCMD's config lists the accounts it has a saved sign-in for, among much else.
check('saved account', readSavedAccounts(`"InstallConfigStore"
{
	"Software" { "Valve" { "Steam" {
		"ConnectCache" { "2bdb63c31" "0123456789abcdef" }
		"Accounts"
		{
			"some_user"
			{
				"SteamID"		"76561190000000000"
			}
		}
		"Other" { "x" "y" }
	} } }
}`), ['some_user']);
check('no saved account', readSavedAccounts('"InstallConfigStore" { "Software" { } }'), []);

// The setup script records the checksum of the patches it built with; the
// picker must hash the patches the same way to tell they are unchanged.
const setupScript = GLib.build_filenamev([GLib.get_current_dir(), 'setup-scene-renderer.sh']);
const prefix = GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-paper-engine']);
GLib.mkdir_with_parents(`${prefix}/bin`, 0o755);
GLib.mkdir_with_parents(`${prefix}/linux-wallpaperengine`, 0o755);
GLib.file_set_contents(`${prefix}/bin/linux-wallpaperengine`, '#!/bin/sh\n');
GLib.chmod(`${prefix}/bin/linux-wallpaperengine`, 0o755);
check('renderer without recorded patches is outdated', isSceneRendererOutdated('', setupScript), true);
GLib.spawn_sync(GLib.get_current_dir(),
    ['sh', '-c', `cat patches/*.patch | sha256sum | cut -d' ' -f1 > ${GLib.shell_quote(`${prefix}/linux-wallpaperengine/patches.sha256`)}`],
    null, GLib.SpawnFlags.SEARCH_PATH, null);
check('renderer built with the current patches is up to date', isSceneRendererOutdated('', setupScript), false);
GLib.file_set_contents(`${prefix}/linux-wallpaperengine/patches.sha256`, '0000\n');
check('renderer built with other patches is outdated', isSceneRendererOutdated('', setupScript), true);
check('renderer built elsewhere is never outdated', isSceneRendererOutdated('/bin/true', setupScript), false);

if (failures > 0)
    System.exit(1);
print('All tests passed');
