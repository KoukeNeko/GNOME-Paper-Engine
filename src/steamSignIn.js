// SPDX-License-Identifier: GPL-3.0-or-later
//
// Steam's own sign-in page in a window of its own (GTK 3 + WebKitGTK, which is
// what this system has), so the password goes to Steam and nowhere else. Once
// Steam has signed in, prints the session cookies as one line of JSON,
// {"cookie", "refresh"}, and exits; closing the window exits with 1. Nothing
// the page stores outlives the process.

import Gtk from 'gi://Gtk?version=3.0';
import GLib from 'gi://GLib';
import WebKit from 'gi://WebKit2?version=4.1';
import System from 'system';

import {gettext as _} from './library.js';

const START_URL = 'https://steamcommunity.com/login/home/?goto=%2F';
// Where the page itself may go; frames inside it, such as reCAPTCHA's, may load any HTTPS site.
const PAGE_HOSTS = ['steamcommunity.com', 'login.steampowered.com', 'help.steampowered.com', 'store.steampowered.com'];

Gtk.init(null);

const context = WebKit.WebContext.new_with_website_data_manager(WebKit.WebsiteDataManager.new_ephemeral());
const view = new WebKit.WebView({web_context: context});
const cookies = context.get_cookie_manager();
const window = new Gtk.Window({title: _('Sign in to Steam'), default_width: 520, default_height: 760});
window.add(view);

function cookieNamed(url, name) {
    return new Promise((resolve, reject) => {
        cookies.get_cookies(url, null, (_manager, result) => {
            try {
                resolve(cookies.get_cookies_finish(result).find(cookie => cookie.get_name() === name)?.get_value() ?? null);
            } catch (e) {
                reject(e);
            }
        });
    });
}

view.connect('decide-policy', (_view, decision, type) => {
    if (type !== WebKit.PolicyDecisionType.NEW_WINDOW_ACTION)
        return false;
    decision.ignore();
    return true;
});

function isPageHost(url) {
    try {
        const uri = GLib.Uri.parse(url, GLib.UriFlags.NONE);
        return uri.get_scheme() === 'https' && PAGE_HOSTS.includes(uri.get_host());
    } catch (e) {
        return false;
    }
}

let signedIn = false;
view.connect('load-changed', (_view, event) => {
    // The window shows no address, so the page never leaves Steam's sign-in hosts.
    if (event !== WebKit.LoadEvent.FINISHED && !isPageHost(view.get_uri())) {
        view.stop_loading();
        view.load_uri(START_URL);
        return;
    }
    if (event !== WebKit.LoadEvent.FINISHED || signedIn)
        return;
    cookieNamed('https://steamcommunity.com/', 'steamLoginSecure').then(async cookie => {
        if (!cookie || signedIn)
            return;
        signedIn = true;
        const refresh = await cookieNamed('https://login.steampowered.com/', 'steamRefresh_steam');
        print(JSON.stringify({cookie, refresh}));
        Gtk.main_quit();
    }).catch(e => console.error(`Cannot read Steam's cookies: ${e.message}`));
});

view.connect('load-failed', (_view, _event, uri, error) => {
    console.warn(`Cannot load ${uri}: ${error.message}`);
    return false;
});

window.connect('destroy', () => Gtk.main_quit());
view.load_uri(START_URL);
window.show_all();
Gtk.main();
System.exit(signedIn ? 0 : 1);
