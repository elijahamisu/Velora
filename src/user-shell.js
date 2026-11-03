// Altivex · user app shell (sidebar + mobile drawer + avatar)
//
// Loaded as the FIRST module script on every signed-in user page, so it runs
// before the page's own script. It replaces the old desktop section nav
// (#sidebar) and account sheet (#mobileDrawer / #drawerOverlay) with one
// sidebar element that is:
//   · md and up  → a persistent left sidebar
//   · below md   → a slide-in drawer opened by the ☰ button in the top bar
// The new markup keeps every id the page scripts use (sidebar, sidebarNav,
// logoutBtn, drawerOverlay, mobileDrawer, drawerClose, drawerNav,
// drawerLogoutBtn, drawerName, drawerRef, drawerBalance, drawerInitials …),
// so existing page logic (active state, drawer open/close, logout, balance)
// keeps working untouched. Ids the new markup does not render are moved into
// a hidden holder rather than deleted.
//
// The shell also paints the user's photo (or initials) in the top bar and
// sidebar on every page. It reads the session supabase-js already stored in
// localStorage and fetches the profile over REST, so it never creates a
// second auth client (no competing token refreshes).

import { cachedSettings, applySettings } from './site-settings.js';
import { initialsOf } from './avatar.js';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
const PROFILE_CACHE = 'ax_shell_profile_v1';

const LOGO_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 1.6 22.4 12 12 22.4 1.6 12z" fill="none" stroke="#D9C7A3" stroke-width="1.1"/><path d="M8.2 16.2 12 7.4l3.8 8.8M9.6 13.1h4.8" fill="none" stroke="#D9C7A3" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const NAV = [
    { label: 'Money', items: [
        ['dashboard', 'Overview', 'layout-grid'],
        ['invest', 'Invest', 'trending-up'],
        ['deposit', 'Deposit', 'arrow-down-left'],
        ['withdraw', 'Withdraw', 'arrow-up-right'],
        ['wallet', 'Wallet', 'wallet'],
        ['transactions', 'Transactions', 'list'],
    ] },
    { label: 'Account', items: [
        ['referral', 'Referrals', 'users'],
        ['gift', 'Gift codes', 'gift'],
        ['notifications', 'Notifications', 'bell'],
        ['profile', 'Profile & security', 'user-round'],
    ] },
    { label: 'Help', items: [
        ['support', 'Support', 'life-buoy'],
    ] },
];

// Ids older page scripts may write to that the sidebar no longer renders
const LEGACY_IDS = [['drawerAvatar', 'img']];

// Pages whose nav item should light up for a related page
const ALIASES = { 'deposit-result': 'deposit' };

function currentPage() {
    const file = (location.pathname.split('/').pop() || 'dashboard.html').replace(/\.html$/, '') || 'dashboard';
    return ALIASES[file] || file;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- markup
function sidebarHTML(page) {
    const groups = NAV.map(g => `
            <p class="ax-sheet-label">${g.label}</p>
            ${g.items.map(([key, label, icon]) => `<a href="${key}.html" data-page="${key}" class="drawer-item sidebar-item${key === page ? ' drawer-active sidebar-active' : ''}"${key === page ? ' aria-current="page"' : ''}><i data-lucide="${icon}"></i><span>${label}</span></a>`).join('')}`).join('');
    return `
    <div class="ax-sheet-head">
        <a href="dashboard.html" aria-label="Altivex home"><span class="ax-logo ax-logo-sm">${LOGO_SVG}<span>Altivex</span></span></a>
        <button id="drawerClose" type="button" aria-label="Close menu" class="ax-icon-btn ax-side-close"><i data-lucide="x"></i></button>
    </div>
    <a href="profile.html" class="ax-sheet-account ax-side-account" aria-label="Your profile">
        <span class="ax-avatar ax-avatar-lg" id="axSideAvatar"><span id="drawerInitials">A</span></span>
        <span class="min-w-0 flex-1 block">
            <span id="drawerName" class="block text-sm font-semibold text-white truncate">&nbsp;</span>
            <span id="axSideEmail" class="block text-[12px] text-[var(--ax-muted)] truncate">&nbsp;</span>
            <span class="ax-side-meta"><span id="drawerRef" class="mono"></span></span>
            <span class="ax-side-meta ax-side-bal">Balance <span id="drawerBalance" class="mono"></span></span>
        </span>
    </a>
    <nav class="ax-sheet-nav" id="drawerNav" aria-label="Main">
        <div id="sidebarNav">${groups}
            <a href="https://t.me/+s66HnQZjuCFhZTI0" data-s-href="telegram_support_link" target="_blank" rel="noopener" class="drawer-item ax-side-ext"><i data-lucide="send"></i><span>Telegram support</span><i data-lucide="arrow-up-right" class="ax-side-ext-icon"></i></a>
        </div>
        <div class="ax-divider my-2"></div>
        <button id="drawerLogoutBtn" type="button" class="drawer-item ax-logout"><i data-lucide="log-out"></i><span>Log out</span></button>
        <button id="logoutBtn" type="button" hidden aria-hidden="true" tabindex="-1"></button>
    </nav>`;
}

function buildShell() {
    const page = currentPage();
    const oldBlocks = ['sidebar', 'drawerOverlay', 'mobileDrawer'].map(id => document.getElementById(id)).filter(Boolean);
    const oldIds = new Set();
    oldBlocks.forEach(b => {
        if (b.id) oldIds.add(b.id);
        b.querySelectorAll('[id]').forEach(el => oldIds.add(el.id));
    });

    const overlay = document.createElement('div');
    overlay.id = 'drawerOverlay';
    overlay.className = 'no-print';

    const side = document.createElement('aside');
    side.id = 'mobileDrawer';
    side.className = 'ax-side no-print';
    side.setAttribute('aria-label', 'Main menu');
    side.innerHTML = sidebarHTML(page);

    // The desktop nav used to be <nav id="sidebar">; keep that id on a wrapper.
    const wrap = document.createElement('div');
    wrap.id = 'sidebar';
    wrap.className = 'ax-side-wrap';
    wrap.append(overlay, side);

    // Ids from the old markup that the new markup does not have: keep the
    // original nodes alive (hidden) so page scripts that write to them never throw.
    const holder = document.createElement('div');
    holder.hidden = true;
    holder.className = 'ax-shell-holder';
    holder.setAttribute('aria-hidden', 'true');
    oldIds.forEach(id => {
        if (wrap.querySelector('#' + CSS.escape(id))) return;
        const el = document.getElementById(id);
        if (el) holder.appendChild(el);
    });
    // Legacy ids some page scripts still write to (old account-sheet photo)
    LEGACY_IDS.forEach(([id, tag]) => {
        if (wrap.querySelector('#' + id) || holder.querySelector('#' + id) || document.getElementById(id)) return;
        const el = document.createElement(tag);
        el.id = id;
        holder.appendChild(el);
    });
    side.appendChild(holder);

    const anchor = oldBlocks[0] || document.querySelector('header.ax-topbar');
    if (anchor && oldBlocks.length) anchor.before(wrap);
    else if (anchor) anchor.after(wrap);
    else document.body.prepend(wrap);
    oldBlocks.forEach(b => b.remove());

    // ☰ button in the top bar (mobile only, via CSS)
    const inner = document.querySelector('header.ax-topbar .ax-topbar-inner');
    const left = inner?.firstElementChild;
    if (left && !document.getElementById('axNavToggle')) {
        const btn = document.createElement('button');
        btn.id = 'axNavToggle';
        btn.type = 'button';
        btn.className = 'ax-icon-btn ax-nav-toggle';
        btn.setAttribute('aria-label', 'Open menu');
        btn.setAttribute('aria-controls', 'mobileDrawer');
        btn.setAttribute('aria-expanded', 'false');
        btn.innerHTML = '<i data-lucide="menu"></i>';
        left.prepend(btn);
    }

    // Pages whose top bar has no account button (e.g. notifications) get an avatar link
    if (inner && !document.getElementById('menuToggle') && !document.getElementById('axTopAvatar')) {
        const right = inner.lastElementChild !== left ? inner.lastElementChild : null;
        const a = document.createElement('a');
        a.id = 'axTopAvatar';
        a.href = 'profile.html';
        a.className = 'ax-avatar-btn ax-avatar-btn-solo';
        a.setAttribute('aria-label', 'Your profile');
        a.innerHTML = '<span class="ax-avatar"></span>';
        if (right) {
            const group = document.createElement('div');
            group.className = 'flex items-center gap-2';
            right.replaceWith(group);
            group.append(right, a);
        } else inner.appendChild(a);
    }

    // Avatars managed by the shell: top bar + sidebar
    document.querySelectorAll('#menuToggle .ax-avatar, #axTopAvatar .ax-avatar, #axSideAvatar').forEach(prepAvatar);

    document.body.classList.add('ax-has-side');
    try { applySettings(cachedSettings(), wrap); } catch (_) { /* defaults stay */ }
    try { window.lucide?.createIcons(); } catch (_) { /* icons render when the page calls it */ }
    return { side, overlay };
}

function prepAvatar(el) {
    el.classList.add('ax-av-managed');
    if (!el.querySelector('.ax-av-img')) {
        const img = document.createElement('img');
        img.className = 'ax-av-img';
        img.alt = '';
        img.hidden = true;
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.addEventListener('error', () => { img.hidden = true; el.classList.remove('ax-av-has-img'); });
        el.prepend(img);
    }
    if (!el.querySelector('.ax-av-ini')) {
        const ini = document.createElement('span');
        ini.className = 'ax-av-ini';
        ini.textContent = 'A';
        el.appendChild(ini);
    }
}

// ---------------------------------------------------------------- avatar/profile
const state = { name: '', email: '', avatar: null };

function paintAvatars() {
    document.querySelectorAll('.ax-avatar.ax-av-managed').forEach(el => {
        const img = el.querySelector('.ax-av-img');
        const ini = el.querySelector('.ax-av-ini');
        ini.textContent = initialsOf(state.name || state.email);
        if (state.avatar) {
            if (img.getAttribute('src') !== state.avatar) img.src = state.avatar;
            img.hidden = false;
            el.classList.add('ax-av-has-img');
        } else {
            img.hidden = true;
            img.removeAttribute('src');
            el.classList.remove('ax-av-has-img');
        }
    });
}

function paintIdentity() {
    const n = document.getElementById('drawerName');
    const e = document.getElementById('axSideEmail');
    if (n && state.name) n.textContent = state.name;
    if (e && state.email) e.textContent = state.email;
    paintAvatars();
}

function readSession() {
    try {
        const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
        const raw = localStorage.getItem(`sb-${ref}-auth-token`);
        if (!raw) return null;
        const s = JSON.parse(raw);
        return s?.access_token ? s : (s?.currentSession || null);
    } catch (_) { return null; }
}

function loadCache(uid) {
    try {
        const c = JSON.parse(localStorage.getItem(PROFILE_CACHE) || 'null');
        return c && c.id === uid ? c : null;
    } catch (_) { return null; }
}
function saveCache(uid) {
    try { localStorage.setItem(PROFILE_CACHE, JSON.stringify({ id: uid, name: state.name, email: state.email, avatar: state.avatar })); } catch (_) {}
}

async function fetchProfile(attempt = 0) {
    const s = readSession();
    if (!s?.user?.id) return;
    const uid = s.user.id;
    const expired = s.expires_at && s.expires_at * 1000 < Date.now() + 5000;
    if (expired && attempt < 6) { setTimeout(() => fetchProfile(attempt + 1), 1500); return; } // page client refreshes it
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=full_name,email,avatar_url`, {
            headers: { apikey: ANON_KEY, Authorization: `Bearer ${s.access_token}`, Accept: 'application/json' },
        });
        if (res.status === 401 && attempt < 6) { setTimeout(() => fetchProfile(attempt + 1), 1500); return; }
        if (!res.ok) return;
        const row = (await res.json())[0];
        if (!row) return;
        state.name = row.full_name || state.name;
        state.email = row.email || s.user.email || state.email;
        state.avatar = row.avatar_url || null;
        saveCache(uid);
        paintIdentity();
    } catch (_) { /* offline: cached identity stays */ }
}

function initIdentity() {
    const s = readSession();
    if (s?.user?.id) {
        state.email = s.user.email || '';
        state.name = s.user.user_metadata?.full_name || '';
        const c = loadCache(s.user.id);
        if (c) { state.name = c.name || state.name; state.email = c.email || state.email; state.avatar = c.avatar || null; }
    }
    paintIdentity();
    fetchProfile();
}

// ---------------------------------------------------------------- behaviour
function wire({ side, overlay }) {
    const toggle = document.getElementById('axNavToggle');
    const menuToggle = document.getElementById('menuToggle');
    const mdUp = window.matchMedia('(min-width: 768px)');

    const open = () => {
        side.classList.add('open');
        overlay.classList.add('open');
        toggle?.setAttribute('aria-expanded', 'true');
        menuToggle?.setAttribute('aria-expanded', 'true');
        document.body.style.overflow = 'hidden';
        side.querySelector('#drawerClose')?.focus({ preventScroll: true });
    };
    const close = () => {
        if (!side.classList.contains('open') && !overlay.classList.contains('open')) return;
        side.classList.remove('open');
        overlay.classList.remove('open');
        toggle?.setAttribute('aria-expanded', 'false');
        menuToggle?.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
    };

    toggle?.addEventListener('click', open);
    overlay.addEventListener('click', close);
    side.querySelector('#drawerClose')?.addEventListener('click', close);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    side.querySelectorAll('a[href]').forEach(a => a.addEventListener('click', close));
    mdUp.addEventListener?.('change', e => { if (e.matches) close(); });

    // On desktop the sidebar is always visible, so the avatar button goes to the
    // profile instead of opening a drawer (capture listener runs before the page's).
    if (menuToggle) {
        menuToggle.setAttribute('aria-label', 'Account');
        menuToggle.addEventListener('click', e => {
            if (mdUp.matches) { e.stopImmediatePropagation(); e.preventDefault(); location.href = 'profile.html'; }
        }, true);
    }

    // Pages without their own logout handler (e.g. notifications) get one here.
    window.addEventListener('load', () => setTimeout(() => {
        ['drawerLogoutBtn', 'logoutBtn'].forEach(id => {
            const b = document.getElementById(id);
            if (b && !b.onclick) b.onclick = shellLogout;
        });
    }, 0));

    return { open, close };
}

async function shellLogout() {
    const s = readSession();
    try {
        if (s?.access_token) {
            await fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
                method: 'POST', headers: { apikey: ANON_KEY, Authorization: `Bearer ${s.access_token}` },
            });
        }
    } catch (_) {}
    try {
        const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
        localStorage.removeItem(`sb-${ref}-auth-token`);
        localStorage.removeItem(PROFILE_CACHE);
    } catch (_) {}
    location.href = 'login.html';
}

// ---------------------------------------------------------------- boot
function boot() {
    if (window.AXShell) return;
    const parts = buildShell();
    const ctl = wire(parts);
    initIdentity();
    window.AXShell = {
        open: ctl.open,
        close: ctl.close,
        refresh: () => fetchProfile(),
        setAvatar(url) {
            state.avatar = url || null;
            const s = readSession(); if (s?.user?.id) saveCache(s.user.id);
            paintAvatars();
        },
        setProfile(p = {}) {
            if (p.full_name) state.name = p.full_name;
            if (p.email) state.email = p.email;
            if ('avatar_url' in p) state.avatar = p.avatar_url || null;
            const s = readSession(); if (s?.user?.id) saveCache(s.user.id);
            paintIdentity();
        },
    };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
