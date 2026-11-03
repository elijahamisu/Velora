// Altivex · site settings (public, read-only for everyone; edited in admin/settings.html)
//
// Every page that shows a configurable value imports from here. Values come
// from the single row in public.site_settings (anon-readable). If the request
// fails, the last cached copy is used, then the DEFAULTS below, which mirror
// the values that used to be hardcoded in the HTML.

export const DEFAULTS = {
    site_name: 'Altivex',
    tagline: 'Put your money to work, daily.',
    support_email: '',
    support_phone: '',
    support_whatsapp: '',
    telegram_link: 'https://t.me/+s66HnQZjuCFhZTI0',
    telegram_support_link: 'https://t.me/+s66HnQZjuCFhZTI0',
    bank_name: 'FIDELITY BANK',
    bank_account_name: 'AMISU ELIJAH',
    bank_account_number: '4580003805',
    min_deposit: 3000,
    max_deposit: null,
    min_withdrawal: 600,
    max_withdrawal: null,
    withdrawal_fee_pct: 15,
    withdrawal_days: [0, 1, 2, 3, 4, 5, 6],
    withdrawal_open_time: '00:00',
    withdrawal_close_time: '23:59',
    welcome_bonus: 600,
    referral_commission_pct: 20,
    maintenance_mode: false,
    maintenance_message: 'We are carrying out scheduled maintenance. Please check back shortly.',
    registration_open: true,
    announcement_text: '',
    // Deposit mode, switched on admin/gateway.html: 'manual' (bank transfer +
    // admin approval) | 'gateway' (Afrstar checkout, credited automatically).
    // Withdrawals are always gateway-based (bank list + admin approval).
    deposit_mode: 'manual',
    payment_mode: 'manual', // legacy alias of deposit_mode, kept in sync by the DB
};

const MONEY_KEYS = ['min_deposit', 'max_deposit', 'min_withdrawal', 'max_withdrawal', 'welcome_bonus'];
const PCT_KEYS = ['withdrawal_fee_pct', 'referral_commission_pct'];
const CACHE_KEY = 'ax_site_settings_v1';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let pending = null;

function normalise(row) {
    const s = { ...DEFAULTS };
    if (!row || typeof row !== 'object') return s;
    for (const k of Object.keys(DEFAULTS)) {
        if (row[k] === undefined) continue;
        if (row[k] === null && !['max_deposit', 'max_withdrawal'].includes(k)) continue;
        s[k] = row[k];
    }
    for (const k of [...MONEY_KEYS, ...PCT_KEYS]) {
        if (s[k] !== null && s[k] !== '') s[k] = Number(s[k]);
        if (Number.isNaN(s[k])) s[k] = DEFAULTS[k];
    }
    for (const k of ['max_deposit', 'max_withdrawal']) {
        if (!s[k] || Number(s[k]) <= 0) s[k] = null;
    }
    s.withdrawal_open_time = String(s.withdrawal_open_time || '00:00').slice(0, 5);
    s.withdrawal_close_time = String(s.withdrawal_close_time || '23:59').slice(0, 5);
    // Older cached rows (before deposit_mode existed) only carry payment_mode.
    if (row.deposit_mode === undefined && row.payment_mode) s.deposit_mode = row.payment_mode;
    if (!['manual', 'gateway'].includes(s.deposit_mode)) s.deposit_mode = 'manual';
    s.payment_mode = s.deposit_mode;
    if (!Array.isArray(s.withdrawal_days)) s.withdrawal_days = DEFAULTS.withdrawal_days;
    s.withdrawal_days = s.withdrawal_days.map(Number);
    return s;
}

function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch { return null; }
}

/** Synchronous best guess: cached copy, else defaults. */
export function cachedSettings() {
    return normalise(readCache());
}

/** Fetch the settings row (once per page load). Never throws. */
export function getSettings({ fresh = false } = {}) {
    if (pending && !fresh) return pending;
    pending = (async () => {
        try {
            const url = import.meta.env.VITE_SUPABASE_URL;
            const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
            const res = await fetch(`${url}/rest/v1/site_settings?id=eq.1&select=*`, {
                headers: { apikey: key, Authorization: `Bearer ${key}` },
                cache: 'no-store',
            });
            if (!res.ok) throw new Error(`settings ${res.status}`);
            const rows = await res.json();
            const row = Array.isArray(rows) ? rows[0] : null;
            if (row) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(row)); } catch {} }
            return normalise(row || readCache());
        } catch (err) {
            console.warn('Site settings unavailable, using fallback:', err);
            return normalise(readCache());
        }
    })();
    return pending;
}

// ---------- Formatting ----------
export function naira(n) {
    const v = Number(n || 0);
    return '₦' + v.toLocaleString('en-NG', { maximumFractionDigits: 2 });
}
export function pct(n) {
    const v = Number(n || 0);
    return `${Number.isInteger(v) ? v : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}
export function formatSetting(s, key) {
    const v = s[key];
    if (MONEY_KEYS.includes(key)) return v === null ? 'No limit' : naira(v);
    if (PCT_KEYS.includes(key)) return pct(v);
    if (key === 'withdrawal_window') return withdrawalWindowLabel(s);
    return v == null ? '' : String(v);
}

// ---------- Withdrawal window (evaluated on Lagos time) ----------
function lagosNow() {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Lagos', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t)?.value;
    return { day: DAY_NAMES.indexOf(get('weekday')), minutes: Number(get('hour')) % 24 * 60 + Number(get('minute')) };
}
const toMin = t => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 60 + (m || 0); };

export function withdrawalWindowLabel(s) {
    const days = [...s.withdrawal_days].sort();
    let dayText;
    if (days.length === 7) dayText = 'Every day';
    else if (days.join() === '1,2,3,4,5') dayText = 'Mon–Fri';
    else if (days.length === 0) dayText = 'Closed';
    else dayText = days.map(d => DAY_NAMES[d]).join(', ');
    const allDay = s.withdrawal_open_time === '00:00' && s.withdrawal_close_time >= '23:59';
    return allDay ? `${dayText}, 24 hours` : `${dayText}, ${s.withdrawal_open_time}–${s.withdrawal_close_time} WAT`;
}

export function isWithdrawalOpen(s) {
    const { day, minutes } = lagosNow();
    if (!s.withdrawal_days.includes(day)) return false;
    const open = toMin(s.withdrawal_open_time), close = toMin(s.withdrawal_close_time);
    return open <= close ? (minutes >= open && minutes <= close) : (minutes >= open || minutes <= close);
}

// ---------- DOM wiring ----------
function hrefFor(kind, value) {
    if (!value) return '';
    if (kind === 'mailto') return `mailto:${value}`;
    if (kind === 'tel') return `tel:${value.replace(/\s+/g, '')}`;
    if (kind === 'whatsapp') return /^https?:/.test(value) ? value : `https://wa.me/${value.replace(/[^\d]/g, '')}`;
    return value;
}

/**
 * Fills elements marked up with:
 *   data-s="key"                 → textContent (money/percent keys formatted)
 *   data-s-href="key"            → href (optional data-s-kind="mailto|tel|whatsapp")
 *   data-s-show="key"            → hidden when that setting is empty
 * and swaps the brand name in logos and the document title.
 */
export function applySettings(s, root = document) {
    root.querySelectorAll('[data-s]').forEach(el => { el.textContent = formatSetting(s, el.dataset.s); });
    root.querySelectorAll('[data-s-href]').forEach(el => {
        const h = hrefFor(el.dataset.sKind, s[el.dataset.sHref]);
        if (h) el.setAttribute('href', h);
    });
    root.querySelectorAll('[data-s-show]').forEach(el => {
        el.classList.toggle('hidden', !s[el.dataset.sShow]);
    });
    if (s.site_name && s.site_name !== 'Altivex') {
        root.querySelectorAll('.ax-logo > span').forEach(el => { if (el.textContent.trim() === 'Altivex') el.textContent = s.site_name; });
        document.title = document.title.replace(/Altivex/g, s.site_name);
    }
}

export function showAnnouncement(s) {
    const text = (s.announcement_text || '').trim();
    if (!text || document.getElementById('axAnnouncement')) return;
    const dismissKey = 'ax_ann_dismissed';
    if (sessionStorage.getItem(dismissKey) === text) return;
    const bar = document.createElement('div');
    bar.id = 'axAnnouncement';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(var(--ax-top,64px) + 10px);z-index:80;' +
        'width:min(640px,calc(100% - 24px));display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:12px;' +
        'background:#141C2F;border:1px solid rgba(217,199,163,0.32);color:#F5F1E8;font:500 13px/1.45 Inter,system-ui,sans-serif;' +
        'box-shadow:0 20px 40px -24px rgba(5,8,16,0.8)';
    const icon = document.createElement('span');
    icon.textContent = '◆';
    icon.style.cssText = 'color:#D9C7A3;font-size:11px;margin-top:2px';
    const msg = document.createElement('p');
    msg.style.cssText = 'flex:1;margin:0';
    msg.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss announcement');
    close.textContent = '✕';
    close.style.cssText = 'color:#A9AEBB;font-size:13px;line-height:1;padding:2px 4px;background:none;border:0;cursor:pointer';
    close.onclick = () => { sessionStorage.setItem(dismissKey, text); bar.remove(); };
    bar.append(icon, msg, close);
    document.body.appendChild(bar);
}

export function showMaintenance(s) {
    if (document.getElementById('axMaintenance')) return;
    const wrap = document.createElement('div');
    wrap.id = 'axMaintenance';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:24px;' +
        'background:#0A0F1C;color:#F5F1E8;text-align:center;font-family:Inter,system-ui,sans-serif';
    wrap.innerHTML = `
        <div style="max-width:420px">
            <svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true" style="margin:0 auto 18px"><path d="M12 1.6 22.4 12 12 22.4 1.6 12z" fill="none" stroke="#D9C7A3" stroke-width="1.1"/><path d="M8.2 16.2 12 7.4l3.8 8.8M9.6 13.1h4.8" fill="none" stroke="#D9C7A3" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:32px;font-weight:600;margin:0 0 10px" id="axMaintTitle"></h1>
            <p style="color:#A9AEBB;font-size:15px;line-height:1.6;margin:0" id="axMaintMsg"></p>
            <a id="axMaintTg" target="_blank" rel="noopener" style="display:inline-block;margin-top:24px;padding:12px 20px;border-radius:10px;background:#D9C7A3;color:#0A0F1C;font-weight:700;font-size:13px;text-decoration:none">Get updates on Telegram</a>
        </div>`;
    wrap.querySelector('#axMaintTitle').textContent = `${s.site_name} is under maintenance`;
    wrap.querySelector('#axMaintMsg').textContent = s.maintenance_message || DEFAULTS.maintenance_message;
    const tg = wrap.querySelector('#axMaintTg');
    if (s.telegram_link) tg.href = s.telegram_link; else tg.remove();
    document.body.appendChild(wrap);
    document.body.style.overflow = 'hidden';
}

/** For pages anyone can open (landing, login, register, terms). */
export async function initPublic({ blockOnMaintenance = true } = {}) {
    applySettings(cachedSettings());
    const s = await getSettings();
    applySettings(s);
    if (blockOnMaintenance && s.maintenance_mode) showMaintenance(s);
    else showAnnouncement(s);
    return s;
}

/**
 * For signed-in app pages. Call right after the session check.
 * Returns { ok, settings, profile }. When ok is false the page must stop:
 * suspended/banned users are signed out and sent to login, and during
 * maintenance non-admins see the maintenance screen.
 */
export async function enforceAccess(supabase, userId) {
    applySettings(cachedSettings());
    const [s, profRes] = await Promise.all([
        getSettings(),
        supabase.from('profiles').select('role, status, status_reason').eq('id', userId).maybeSingle(),
    ]);
    applySettings(s);
    const profile = profRes?.data || null;
    const isAdmin = ['admin', 'super_admin'].includes(profile?.role);

    if (profile && profile.status && profile.status !== 'active' && !isAdmin) {
        await supabase.auth.signOut();
        window.location.href = `login.html?blocked=${encodeURIComponent(profile.status)}`;
        return { ok: false, settings: s, profile };
    }
    if (s.maintenance_mode && !isAdmin) {
        showMaintenance(s);
        return { ok: false, settings: s, profile };
    }
    showAnnouncement(s);
    return { ok: true, settings: s, profile };
}

export function blockedMessage(status, reason) {
    const base = status === 'banned'
        ? 'This account has been banned.'
        : 'This account is suspended.';
    return `${base}${reason ? ` Reason: ${reason}.` : ''} Please contact support if you think this is a mistake.`;
}
