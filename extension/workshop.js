// SPDX-License-Identifier: GPL-3.0-or-later
//
// Browsing the Steam Workshop for Wallpaper Engine.
//
// Steam's query API needs a key and a login, so this reads the public browse
// page instead, which embeds its results as JSON. That is not a stable
// interface: when Steam changes the page, parseBrowsePage() throws and the
// picker shows the error.

import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

const BROWSE_URL = 'https://steamcommunity.com/workshop/browse/';
const WALLPAPER_ENGINE_APP_ID = '431960';

const SORT_PARAMETERS = {
    trend: 'browsesort=trend&days=7',
    recent: 'browsesort=mostrecent',
    top: 'browsesort=totaluniquesubscribers',
};

const TYPE_BY_TAG = {Scene: 'scene', Video: 'video', Web: 'web'};

// Browsing shows dozens of previews at a time: fetch them side by side, and
// keep them on disk so a page that was seen before appears at once.
const CACHE_SIZE_BYTES = 128 * 1024 * 1024;
const session = new Soup.Session({
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64)', timeout: 20, max_conns: 16, max_conns_per_host: 12,
});
const cache = new Soup.Cache({
    cache_dir: GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-paper-engine', 'http']),
    cache_type: Soup.CacheType.SINGLE_USER,
});
cache.set_max_size(CACHE_SIZE_BYTES);
cache.load();
session.add_feature(cache);

/** Writes the index of the HTTP cache to disk; without it the cached files are not found again. */
export function saveCache() {
    cache.flush();
    cache.dump();
}

/** The Steam client URL of a Workshop item's page. */
export function steamPageUri(id) {
    return `steam://url/CommunityFilePage/${id}`;
}

function fetchBytes(url, cancellable) {
    return new Promise((resolve, reject) => {
        const message = Soup.Message.new('GET', url);
        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                if (message.get_status() !== Soup.Status.OK)
                    throw new Error(`Steam answered ${message.get_status()} ${message.get_reason_phrase()}`);
                resolve(bytes);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Index of the `]` closing the JSON array that starts at the beginning of `text`. */
function findArrayEnd(text) {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (char === '\\')
                i++;
            else if (char === '"')
                inString = false;
        } else if (char === '"') {
            inString = true;
        } else if (char === '[' || char === '{') {
            depth++;
        } else if (char === ']' || char === '}') {
            if (--depth === 0)
                return i;
        }
    }
    throw new Error('Unterminated Workshop result list');
}

/** Extracts the result list from the HTML of a Workshop browse page. */
export function parseBrowsePage(html) {
    const marker = '\\"results\\":[';
    const start = html.indexOf(marker);
    if (start < 0)
        throw new Error('The Workshop page no longer has the expected format');

    // The results are JSON inside a JavaScript string literal: undo that one
    // level of escaping (\\\" is an escaped quote inside a JSON string).
    const text = html.slice(start + marker.length - 1)
        .replaceAll('\\\\\\"', '\u0001')
        .replaceAll('\\"', '"')
        .replaceAll('\u0001', '\\"')
        .replaceAll('\\\\u', '\\u');
    const results = JSON.parse(text.slice(0, findArrayEnd(text) + 1));

    return results.map(result => {
        const tags = result.tags ?? [];
        return {
            id: result.publishedfileid,
            title: result.title,
            previewUrl: result.preview_url,
            description: (result.short_description ?? '').replace(/\\+[nrt]/g, ' ').trim(),
            size: Number(result.file_size ?? 0),
            subscriptions: result.subscriptions ?? 0,
            favorited: result.favorited ?? 0,
            stars: result.star_rating ?? 0,
            votes: result.total_votes ?? 0,
            updated: result.time_updated ?? 0,
            type: TYPE_BY_TAG[tags.find(({tag}) => tag in TYPE_BY_TAG)?.tag] ?? 'scene',
            tags: tags.map(tag => tag.display_name).filter(name => name !== '桌布' && name !== 'Wallpaper'),
        };
    });
}

/**
 * One page of Workshop wallpapers. `sort` is trend | recent | top, `tag` an
 * optional Workshop tag (English name), `page` starts at 1.
 */
export async function browse({sort, query = '', tag = null, page = 1}, cancellable = null) {
    const parameters = [
        `appid=${WALLPAPER_ENGINE_APP_ID}`,
        'section=readytouseitems',
        SORT_PARAMETERS[sort],
        `p=${page}`,
        'l=tchinese',
        // Only all-ages wallpapers.
        `requiredtags%5B%5D=Everyone`,
    ];
    if (tag)
        parameters.push(`requiredtags%5B%5D=${encodeURIComponent(tag)}`);
    if (query)
        parameters.push(`searchtext=${encodeURIComponent(query)}`);
    const bytes = await fetchBytes(`${BROWSE_URL}?${parameters.join('&')}`, cancellable);
    return parseBrowsePage(new TextDecoder().decode(bytes.toArray()));
}

/** Downloads a preview image (optionally scaled down by Steam's CDN) as GLib.Bytes. */
export function fetchPreview(previewUrl, size = null, cancellable = null) {
    const url = size ? `${previewUrl}?imw=${size}&imh=${size}&ima=fit&impolicy=Letterbox` : previewUrl;
    return fetchBytes(url, cancellable);
}
