// Altivex · output-encoding helpers (shared by every user and admin page)
//
// Anything that comes from the database, a URL parameter, localStorage, a
// gateway response or the user must go through one of these before it is put
// into HTML built from strings (innerHTML / template literals):
//
//   esc(v)          text or a quoted attribute value  → `<td>${esc(name)}</td>`
//                                                      `<a title="${esc(note)}">`
//   safeUrl(v)      href / link targets: http(s), mailto:, tel: and relative
//                   paths only; anything else (javascript:, data:, vbscript:,
//                   protocol-relative //evil) becomes '' — then still esc() it
//                   when it goes into markup.
//   safeImageUrl(v) <img src>: relative paths, blob: previews made by the
//                   page itself, and files in this project's Supabase Storage
//                   (…/storage/v1/object/public/…). Anything else becomes ''.
//   safeId(v)       an id going into a data- attribute / selector: UUIDs and
//                   plain [A-Za-z0-9_-] tokens only, otherwise ''.
//
// Prefer element.textContent where the markup is simple; these helpers are
// for the places that build rows/cards as HTML strings.

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escape a value for an HTML text node or a quoted attribute value. */
export function esc(value) {
    return String(value ?? '').replace(/[&<>"'`]/g, c => HTML_ESCAPES[c]);
}

function supabaseOrigin() {
    try {
        const u = import.meta.env?.VITE_SUPABASE_URL;
        return u ? new URL(u).origin : '';
    } catch (_) { return ''; }
}

// Characters browsers strip before parsing a scheme ("java\tscript:", leading
// control chars / spaces), removed before the scheme check.
const STRIP = /[\u0000-\u0020\u007f-\u009f]/g;

function cleanUrl(value) {
    if (value == null) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    return raw;
}

function schemeOf(raw) {
    const m = raw.replace(STRIP, '').match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
    return m ? m[1].toLowerCase() : null;
}

function isRelative(raw) {
    const s = raw.replace(STRIP, '');
    // Protocol-relative (//host) and backslash tricks (/\host) leave the site.
    if (/^[\\/]{2}/.test(s) || /^\/\\/.test(s)) return false;
    return schemeOf(raw) === null;
}

/**
 * A link target that is safe to put in href/location: http(s), mailto, tel
 * or a relative path. Returns '' for anything else.
 * Pass { allow: ['http', 'https'] } to narrow the schemes.
 */
export function safeUrl(value, { allow = ['http', 'https', 'mailto', 'tel'] } = {}) {
    const raw = cleanUrl(value);
    if (!raw) return '';
    if (isRelative(raw)) return raw;
    const scheme = schemeOf(raw);
    if (!allow.includes(scheme)) return '';
    if (scheme === 'http' || scheme === 'https') {
        try { new URL(raw); } catch (_) { return ''; }
    }
    return raw;
}

/**
 * An image source: relative paths, blob: object URLs created by the page, and
 * public files in this project's Supabase Storage. Returns '' otherwise.
 * `origin` is only for tests; pages use VITE_SUPABASE_URL.
 */
export function safeImageUrl(value, { origin = supabaseOrigin() } = {}) {
    const raw = cleanUrl(value);
    if (!raw) return '';
    if (isRelative(raw)) return raw;
    const scheme = schemeOf(raw);
    if (scheme === 'blob') return /^blob:https?:\/\//i.test(raw) ? raw : '';
    if (scheme !== 'https' && scheme !== 'http') return '';
    if (!origin) return '';
    try {
        const u = new URL(raw);
        if (u.origin !== origin) return '';
        if (!u.pathname.startsWith('/storage/v1/')) return '';
        return u.href;
    } catch (_) { return ''; }
}

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** A row id safe for data- attributes / querySelector: UUID-ish tokens only. */
export function safeId(value) {
    const s = String(value ?? '');
    return ID_RE.test(s) ? s : '';
}
