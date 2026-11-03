// node --test tests/escape.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { esc, safeUrl, safeImageUrl, safeId } from '../src/escape.js';
import { hrefFor } from '../src/site-settings.js';
import { bankOptionsHtml } from '../src/ng-banks.js';

const ORIGIN = 'https://abcd1234.supabase.co';

test('esc encodes every HTML-significant character', () => {
    assert.equal(esc(`<img src=x onerror=alert(1)>`), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(esc(`"><svg onload=alert(1)>`), '&quot;&gt;&lt;svg onload=alert(1)&gt;');
    assert.equal(esc(`a & b ' \``), 'a &amp; b &#39; &#96;');
    assert.equal(esc('&amp;'), '&amp;amp;', 'double-escapes, never trusts existing entities');
});

test('esc handles non-strings', () => {
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(0), '0');
    assert.equal(esc(12.5), '12.5');
    assert.equal(esc(false), 'false');
    assert.equal(esc({ toString: () => '<b>' }), '&lt;b&gt;');
});

test('safeUrl allows http(s), mailto, tel and relative links', () => {
    assert.equal(safeUrl('https://t.me/+abc'), 'https://t.me/+abc');
    assert.equal(safeUrl('http://example.com/x?y=1'), 'http://example.com/x?y=1');
    assert.equal(safeUrl('mailto:help@altivex.ng'), 'mailto:help@altivex.ng');
    assert.equal(safeUrl('tel:+2348000000000'), 'tel:+2348000000000');
    assert.equal(safeUrl('user.html?id=1'), 'user.html?id=1');
    assert.equal(safeUrl('/deposit.html'), '/deposit.html');
    assert.equal(safeUrl('#top'), '#top');
});

test('safeUrl rejects script and other dangerous schemes', () => {
    for (const bad of [
        'javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
        '\u0001javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,<script>alert(1)</script>',
        '//evil.example/x', '/\\evil.example', '\\\\evil.example', 'file:///etc/passwd', 'https://',
    ]) assert.equal(safeUrl(bad), '', bad);
    assert.equal(safeUrl(null), '');
    assert.equal(safeUrl(''), '');
});

test('safeUrl can be narrowed to http(s) only', () => {
    const httpOnly = { allow: ['https', 'http'] };
    assert.equal(safeUrl('mailto:x@y.z', httpOnly), '');
    assert.equal(safeUrl('https://pay.example/checkout/1', httpOnly), 'https://pay.example/checkout/1');
});

test('safeImageUrl only allows this project\'s Storage, relative paths and blob: previews', () => {
    const good = `${ORIGIN}/storage/v1/object/public/avatars/0f1e/avatar-1.webp`;
    assert.equal(safeImageUrl(good, { origin: ORIGIN }), good);
    assert.equal(safeImageUrl('/img/logo.png', { origin: ORIGIN }), '/img/logo.png');
    assert.equal(safeImageUrl('blob:https://altivex.app/2b1c', { origin: ORIGIN }), 'blob:https://altivex.app/2b1c');
    for (const bad of [
        'https://evil.example/x.png',
        `${ORIGIN}.evil.example/storage/v1/object/public/a.png`,
        `${ORIGIN}/rest/v1/profiles`,
        'javascript:alert(1)',
        'data:image/svg+xml,<svg onload=alert(1)>',
        '//evil.example/a.png',
        'blob:null/abc',
    ]) assert.equal(safeImageUrl(bad, { origin: ORIGIN }), '', bad);
    assert.equal(safeImageUrl(good, { origin: '' }), '', 'no configured origin → no remote images');
});

test('safeId keeps UUIDs and plain tokens only', () => {
    const uuid = '3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b';
    assert.equal(safeId(uuid), uuid);
    assert.equal(safeId('ALT_123'), 'ALT_123');
    assert.equal(safeId("1'); alert(1); ('"), '');
    assert.equal(safeId('"><svg onload=alert(1)>'), '');
    assert.equal(safeId(''), '');
    assert.equal(safeId(null), '');
});

test('site settings links go through safeUrl', () => {
    assert.equal(hrefFor('', 'javascript:alert(1)'), '');
    assert.equal(hrefFor('', 'https://t.me/+abc'), 'https://t.me/+abc');
    assert.match(hrefFor('whatsapp', 'javascript:alert(1)'), /^(https:\/\/wa\.me\/\d*)?$/); // digits only, never a script URL
    assert.equal(hrefFor('whatsapp', 'javascript:'), '');
    assert.equal(hrefFor('whatsapp', '+234 801 234 5678'), 'https://wa.me/2348012345678');
    assert.equal(hrefFor('mailto', 'help@altivex.ng'), 'mailto:help@altivex.ng');
    assert.equal(hrefFor('mailto', 'x@y.z?body=<script>'), '');
    assert.equal(hrefFor('tel', '+234 801-234-5678'), 'tel:+2348012345678');
});

test('bank dropdown markup escapes its placeholder', () => {
    const html = bankOptionsHtml({ placeholder: '<img src=x onerror=alert(1)>' });
    assert.ok(html.startsWith('<option value="">&lt;img src=x onerror=alert(1)&gt;</option>'));
    assert.ok(!html.includes('<img'));
});

test('no unescaped interpolations into HTML remain (scripts/check-xss.mjs)', () => {
    const out = execFileSync(process.execPath, ['scripts/check-xss.mjs'], { encoding: 'utf8' });
    assert.match(out, /OK: no unescaped interpolations/);
});
