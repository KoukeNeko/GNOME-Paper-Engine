// SPDX-License-Identifier: GPL-3.0-or-later
//
// The account's Workshop subscriptions, through a Steam Community session
// taken from Steam's own sign-in page (steamSignIn.js), so the password never
// passes through here. The session is kept in the keyring, and its cookies go
// only to steamcommunity.com, the renewal token only to login.steampowered.com.

import GLib from 'gi://GLib';
import Secret from 'gi://Secret';
import Soup from 'gi://Soup?version=3.0';

import {WALLPAPER_ENGINE_APP_ID} from './library.js';

const SCHEMA = new Secret.Schema('io.github.koukeneko.Nekoland.PaperEngine.SteamCommunity',
    Secret.SchemaFlags.NONE, {kind: Secret.SchemaAttributeType.STRING});
const ATTRIBUTES = {kind: 'session'};
const RENEWAL_URL = 'https://login.steampowered.com/jwt/ajaxrefresh';
const TOKEN_TRANSFER_URL = 'https://steamcommunity.com/login/settoken';
const PAGE_SIZE = 30;
// Renewed this long before the cookie's token runs out.
const RENEWAL_MARGIN_S = 120;

// Cookies are set by hand on each request, so the session keeps no jar.
const http = new Soup.Session({timeout: 35, user_agent: 'Mozilla/5.0 (X11; Linux x86_64)'});

/** Steam ended the session, or never had one: sign in again. */
export class SignInRequired extends Error {
    constructor() {
        super('Steam asked to sign in again');
    }
}

/**
 * The session in the cookies Steam's sign-in page set: `steamLoginSecure`,
 * `<SteamID64>||<token>` with the bars percent-encoded or not, and
 * `steamRefresh_steam` of the same form, or null when the cookie is not one.
 */
export function sessionFromCookies(cookie, refresh = null) {
    const parts = value => value?.match(/^(\d{17})(?:%7C%7C|\|\|)(.+)$/i)?.slice(1) ?? null;
    const [steamID, token] = parts(cookie) ?? [];
    if (!steamID)
        return null;
    const [refreshID, refreshToken] = parts(refresh) ?? [];
    return {steamID, cookie, refreshToken: refreshID === steamID ? refreshToken : null, expiresAt: tokenExpiry(token)};
}

// The `exp` of a JWT, read without checking its signature, or null.
function tokenExpiry(token) {
    try {
        const payload = token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
        const exp = JSON.parse(new TextDecoder().decode(GLib.base64_decode(payload))).exp;
        return Number.isFinite(exp) ? exp : null;
    } catch (e) {
        return null;
    }
}

function secretCall(start, finish) {
    return new Promise((resolve, reject) => {
        start((_source, result) => {
            try {
                resolve(finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** The saved session, or null. */
export async function loadSession() {
    const saved = await secretCall(
        callback => Secret.password_lookup(SCHEMA, ATTRIBUTES, null, callback),
        result => Secret.password_lookup_finish(result));
    if (!saved)
        return null;
    try {
        const {cookie, refresh} = JSON.parse(saved);
        return sessionFromCookies(cookie, refresh);
    } catch (e) {
        console.warn(`Unreadable saved Steam session: ${e.message}`);
        return null;
    }
}

export function saveSession(session) {
    const refresh = session.refreshToken ? `${session.steamID}%7C%7C${session.refreshToken}` : null;
    return secretCall(
        callback => Secret.password_store(SCHEMA, ATTRIBUTES, Secret.COLLECTION_DEFAULT, 'Paper Engine Steam session',
            JSON.stringify({cookie: session.cookie, refresh}), null, callback),
        result => Secret.password_store_finish(result));
}

export function clearSession() {
    return secretCall(
        callback => Secret.password_clear(SCHEMA, ATTRIBUTES, null, callback),
        result => Secret.password_clear_finish(result));
}

// Sends a request that follows no redirect, so a cookie never leaves the host it is for.
function send(method, url, {cookie, form = null, cancellable = null}) {
    const message = Soup.Message.new(method, url);
    message.flags |= Soup.MessageFlags.NO_REDIRECT;
    const headers = message.get_request_headers();
    if (cookie)
        headers.append('Cookie', cookie);
    if (form) {
        headers.append('Origin', 'https://steamcommunity.com');
        headers.append('Referer', 'https://steamcommunity.com/');
        message.set_request_body_from_bytes('application/x-www-form-urlencoded',
            new GLib.Bytes(new TextEncoder().encode(Soup.form_encode_hash(form))));
    }
    return new Promise((resolve, reject) => {
        http.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_http, result) => {
            try {
                const bytes = http.send_and_read_finish(result);
                const status = message.get_status();
                if (status === 401 || status === 403)
                    throw new SignInRequired();
                resolve({status, message, text: new TextDecoder().decode(bytes.toArray())});
            } catch (e) {
                reject(e);
            }
        });
    });
}

function setCookie(message, name) {
    const cookies = Soup.cookies_from_response(message);
    return cookies.find(cookie => cookie.get_name() === name && cookie.get_value() !== '')?.get_value() ?? null;
}

function readJSON(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

/**
 * A new cookie for `session`, the way Steam's sign-in page renews a browser
 * session: the renewal token is traded at login.steampowered.com for one-time
 * fields that set a fresh cookie on steamcommunity.com.
 */
async function renew(session, cancellable) {
    if (!session.refreshToken)
        throw new SignInRequired();
    const refresh = await send('POST', RENEWAL_URL, {
        cookie: `steamRefresh_steam=${session.steamID}%7C%7C${session.refreshToken}`,
        form: {redir: 'https://steamcommunity.com/'},
        cancellable,
    });
    const answer = readJSON(refresh.text);
    if (refresh.status !== 200 || !answer || (answer.success !== true && answer.success !== 1) ||
        answer.login_url !== TOKEN_TRANSFER_URL || !answer.nonce || !answer.auth ||
        (answer.steamID && answer.steamID !== session.steamID))
        throw new SignInRequired();
    const form = {steamID: session.steamID};
    for (const [key, value] of Object.entries(answer)) {
        if (!['success', 'login_url', 'error'].includes(key) && ['string', 'number'].includes(typeof value))
            form[key] = `${value}`;
    }
    const transfer = await send('POST', TOKEN_TRANSFER_URL, {cookie: null, form, cancellable});
    const cookie = setCookie(transfer.message, 'steamLoginSecure');
    if (transfer.status !== 200 || readJSON(transfer.text)?.result !== 1 || !cookie)
        throw new SignInRequired();
    const rotated = setCookie(refresh.message, 'steamRefresh_steam');
    const renewed = sessionFromCookies(cookie, rotated ?? `${session.steamID}%7C%7C${session.refreshToken}`);
    if (renewed?.steamID !== session.steamID)
        throw new SignInRequired();
    await saveSession(renewed);
    return renewed;
}

/** `session`, renewed first when its cookie is about to run out. */
export function freshSession(session, cancellable = null) {
    const expiring = session.expiresAt !== null && session.expiresAt - RENEWAL_MARGIN_S < Date.now() / 1000;
    return expiring ? renew(session, cancellable) : Promise.resolve(session);
}

function isSignInPage(html) {
    const title = html.match(/<title\b[^>]*>([^<]*)<\/title>/i)?.[1].trim() ?? '';
    return title === 'Sign In' || title === 'Steam Community :: Sign In' ||
        /"route"\s*:\s*"\/login(?:\/[^"]*)?"/i.test(html);
}

/**
 * The Workshop item ids on one page of the account's subscriptions, and how
 * many there are in all. Throws SignInRequired for Steam's sign-in page or an
 * anonymous one, and an error for a page that says nothing reliable.
 */
export function parseSubscriptionsPage(html) {
    // Each subscription is a row `<div class="workshopItemSubscription " id="Subscription<id>">`.
    const ids = [...new Set([...html.matchAll(/\bid\s*=\s*["'](?:Subscription|UnsubscribeItemBtn)(\d+)["']/g)].map(m => m[1]))];
    if (ids.length === 0 && isSignInPage(html))
        throw new SignInRequired();
    // The account's own list served to nobody in particular.
    if (/\bg_steamID\s*=\s*false\s*;/.test(html) || /"logged_in"\s*:\s*false/.test(html))
        throw new SignInRequired();
    const paging = html.match(/Showing\s+([\d,]+)\s*-\s*[\d,]+\s+of\s+([\d,]+)\s+entries/);
    const total = paging ? Number(paging[2].replaceAll(',', '')) : null;
    // A blank, cut-off or changed page is no proof of zero subscriptions.
    if (ids.length === 0 && total !== 0 && !/No matching files were found/.test(html))
        throw new Error('Steam returned an unreadable subscriptions page');
    return {ids, total: total ?? ids.length};
}

/** Every Workshop item the account subscribes to for Wallpaper Engine. */
export async function fetchSubscriptions(session, cancellable = null) {
    const ids = [];
    for (let page = 1; ; page++) {
        const url = `https://steamcommunity.com/profiles/${session.steamID}/myworkshopfiles/` +
            `?appid=${WALLPAPER_ENGINE_APP_ID}&browsefilter=mysubscriptions&p=${page}&numperpage=${PAGE_SIZE}&l=english`;
        const response = await send('GET', url, {cookie: `steamLoginSecure=${session.cookie}`, cancellable});
        // A session Steam no longer takes redirects to its sign-in page.
        if (response.status >= 300 && response.status < 400)
            throw new SignInRequired();
        if (response.status !== 200)
            throw new Error(`Steam answered ${response.status} for the subscriptions`);
        const listing = parseSubscriptionsPage(response.text);
        ids.push(...listing.ids.filter(id => !ids.includes(id)));
        if (listing.ids.length === 0 || ids.length >= listing.total)
            return ids;
    }
}

/** Subscribes the account to the Workshop item `id`, or unsubscribes it. */
export async function setSubscribed(session, id, subscribed, cancellable = null) {
    // Steam's CSRF check only compares the form field with a cookie of the same value.
    const token = GLib.uuid_string_random().replaceAll('-', '').slice(0, 24);
    const response = await send('POST', `https://steamcommunity.com/sharedfiles/${subscribed ? 'subscribe' : 'unsubscribe'}`, {
        cookie: `steamLoginSecure=${session.cookie}; sessionid=${token}`,
        form: {id, appid: WALLPAPER_ENGINE_APP_ID, sessionid: token},
        cancellable,
    });
    if (response.status >= 300 && response.status < 400 || isSignInPage(response.text))
        throw new SignInRequired();
    const success = readJSON(response.text)?.success;
    if (response.status !== 200 || success !== 1)
        throw new Error(`Steam did not ${subscribed ? 'subscribe' : 'unsubscribe'} (${response.status}, ${success})`);
}
