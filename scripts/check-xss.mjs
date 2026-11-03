#!/usr/bin/env node
// Altivex · grep-style XSS check
//
// Scans every page script (*.html, admin/*.html) and src/*.js for:
//   1. `${…}` interpolations inside template literals that build HTML
//      (the literal contains a tag) whose value is not passed through an
//      encoder (esc / safeUrl / safeImageUrl / safeId) or a known-safe
//      formatter (numbers, dates, fixed enums → see SAFE_CALLS / SAFE_NAMES);
//   2. innerHTML / outerHTML / insertAdjacentHTML / document.write sinks fed
//      by something other than a literal or a template literal;
//   3. inline on*="…${…}…" handlers built from interpolated values.
//
// Exit code 1 when anything is reported, so it can run in CI:
//   node scripts/check-xss.mjs            (summary + findings)
//   node scripts/check-xss.mjs --verbose  (also lists every accepted interpolation)

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const VERBOSE = process.argv.includes('--verbose');

// Encoders: their output is safe in HTML text and quoted attributes.
const ENCODERS = ['esc', 'safeUrl', 'safeImageUrl', 'safeId', 'escapeHtml', 'escHtml', 'encodeURIComponent'];

// Calls whose result is safe everywhere: numbers and the shared formatters
// from src/site-settings.js (digits, separators, ₦, %).
const SAFE_CALLS = ['Number', 'Math.round', 'Math.floor', 'Math.ceil', 'Math.max', 'Math.min', 'Math.abs', 'parseFloat', 'parseInt', 'naira', 'pct', 'AX.naira', 'AX.pct'];

// Per-file reviewed exceptions live in scripts/xss-reviewed.json:
//   safeCalls[file]  helpers in that file that return markup built only from
//                    escaped values / fixed strings, or numbers / dates;
//   safeNames[file]  local variables that only ever hold numbers, fixed
//                    strings or already-escaped markup;
//   sinks[]          { file, contains } innerHTML sinks fed by such a variable.
const REVIEWED = JSON.parse(readFileSync(join(ROOT, 'scripts', 'xss-reviewed.json'), 'utf8'));
const SAFE_NAMES_GLOBAL = new Set(['LOGO_SVG']);

const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'typeof', 'new', 'this', 'return', 'of', 'in', 'instanceof', 'void']);

function listFiles() {
    const out = [];
    for (const f of readdirSync(ROOT)) if (f.endsWith('.html')) out.push(join(ROOT, f));
    for (const dir of ['admin', 'src']) {
        const d = join(ROOT, dir);
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) if (/\.(html|js)$/.test(f)) out.push(join(d, f));
    }
    return out;
}

// Pull JS out of <script> blocks (keeps line numbers by padding).
function scriptsOf(file, text) {
    if (file.endsWith('.js')) return text;
    let js = '';
    const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let last = 0, m;
    while ((m = re.exec(text))) {
        const before = text.slice(last, m.index + m[0].indexOf('>') + 1);
        js += before.replace(/[^\n]/g, ' ');
        js += m[1];
        last = m.index + m[0].length - '</script>'.length;
    }
    js += text.slice(last).replace(/[^\n]/g, ' ');
    return js;
}

// Minimal tokenizer: finds template literals (with nesting) and their ${} parts.
function templates(js) {
    const found = [];
    let i = 0;
    const len = js.length;
    function skipString(q) { i++; while (i < len && js[i] !== q) { if (js[i] === '\\') i++; i++; } i++; }
    // A '/' starts a regex literal when the previous token cannot end an expression.
    function regexAllowed() {
        let j = i - 1;
        while (j >= 0 && /\s/.test(js[j])) j--;
        if (j < 0) return true;
        if ('(,=:[!&|?{};+-*%<>~^'.includes(js[j])) return true;
        const word = js.slice(Math.max(0, j - 10), j + 1).match(/[A-Za-z_$]+$/);
        return !!word && ['return', 'typeof', 'case', 'in', 'of', 'void', 'delete', 'throw', 'else'].includes(word[0]);
    }
    function skipRegex() {
        i++; let inClass = false;
        while (i < len && js[i] !== '\n') {
            const c = js[i];
            if (c === '\\') { i += 2; continue; }
            if (c === '[') inClass = true; else if (c === ']') inClass = false;
            else if (c === '/' && !inClass) { i++; break; }
            i++;
        }
    }
    function readTemplate() {
        const start = i; i++;
        const parts = []; const exprs = [];
        let chunk = '';
        while (i < len && js[i] !== '`') {
            if (js[i] === '\\') { chunk += js[i] + js[i + 1]; i += 2; continue; }
            if (js[i] === '$' && js[i + 1] === '{') {
                i += 2; const es = i; let depth = 1;
                while (i < len && depth) {
                    const c = js[i];
                    if (c === '`') { readTemplate(); continue; }
                    if (c === '"' || c === "'") { skipString(c); continue; }
                    if (c === '/' && regexAllowed()) { skipRegex(); continue; }
                    if (c === '{') depth++;
                    else if (c === '}') { depth--; if (!depth) break; }
                    i++;
                }
                exprs.push({ expr: js.slice(es, i), pos: es });
                parts.push(chunk); chunk = '';
                i++; continue;
            }
            chunk += js[i]; i++;
        }
        parts.push(chunk);
        i++;
        found.push({ start, end: i, text: parts.join('\u0000'), parts, exprs });
    }
    while (i < len) {
        const c = js[i];
        if (c === '/' && js[i + 1] === '/') { while (i < len && js[i] !== '\n') i++; continue; }
        if (c === '/' && js[i + 1] === '*') { i = js.indexOf('*/', i + 2); i = i < 0 ? len : i + 2; continue; }
        if (c === '"' || c === "'") { skipString(c); continue; }
        if (c === '`') { readTemplate(); continue; }
        if (c === '/' && regexAllowed()) { skipRegex(); continue; }
        i++;
    }
    return found;
}

function stripTemplates(src) {
    let out = '', i = 0;
    while (i < src.length) {
        if (src[i] !== '`') { out += src[i++]; continue; }
        let depth = 0; i++;
        while (i < src.length) {
            if (src[i] === '\\') { i += 2; continue; }
            if (depth === 0 && src[i] === '`') { i++; break; }
            if (src[i] === '$' && src[i + 1] === '{') { depth++; i += 2; continue; }
            if (depth > 0 && src[i] === '}') { depth--; i++; continue; }
            if (depth > 0 && src[i] === '`') { // nested template inside ${}
                const rest = stripTemplates(src.slice(i)); // consume recursively
                let j = i + 1, d2 = 0;
                while (j < src.length) { if (src[j] === '\\') { j += 2; continue; } if (d2 === 0 && src[j] === '`') { j++; break; } if (src[j] === '$' && src[j + 1] === '{') { d2++; j += 2; continue; } if (d2 > 0 && src[j] === '}') d2--; j++; }
                i = j; continue;
            }
            i++;
        }
        out += "''";
    }
    return out;
}

const lineOf = (js, pos) => js.slice(0, pos).split('\n').length;

function stripBalanced(s, name) {
    // replace name( … ) (balanced) with 0
    let out = '', i = 0;
    const re = new RegExp(`(^|[^\\w.$])(${name.replace(/[.(]/g, m => '\\' + m)})\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(s))) {
        const open = m.index + m[0].length - 1;
        let depth = 1, j = open + 1;
        while (j < s.length && depth) { if (s[j] === '(') depth++; else if (s[j] === ')') depth--; j++; }
        out += s.slice(i, m.index + m[1].length) + '0';
        i = j; re.lastIndex = j;
    }
    return out + s.slice(i);
}

function classify(expr, rel, { inHandler = false } = {}) {
    const calls = inHandler ? ['safeId', ...SAFE_CALLS] : [...ENCODERS, ...SAFE_CALLS, ...(REVIEWED.safeCalls?.[rel] || [])];
    const names = new Set([...SAFE_NAMES_GLOBAL, ...(REVIEWED.safeNames?.[rel] || [])]);
    let e = expr.trim();
    if (/^\/\*\s*safe\b[^*]*\*\//.test(e)) return { ok: true, why: 'annotated safe' };
    if (e.includes('`')) {
        if (inHandler) return { ok: false, ids: ['template'] };
        // Nested templates are checked on their own; what is left around them
        // (ternary branches, .map(x => …).join('')) must still be safe.
        e = stripTemplates(e)
            .replace(/[\w$.?\[\]]*\.map\(\s*\(?[\w\s,$\[\]{}]*\)?\s*=>\s*(''|\{[\s\S]*\})\s*\)/g, "''")
            .replace(/\.join\(\s*''\s*\)/g, '')
            .replace(/\.filter\((?:[^()]|\([^()]*\))*\)/g, '')
            .replace(/\.slice\([^()]*\)/g, '');
        const r = classify(e, rel);
        return r.ok ? { ok: true, why: 'nested template (checked separately)' } : r;
    }
    e = e.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
    for (const n of calls) e = stripBalanced(e, n);
    // new Date(…).toLocale…(…) only ever yields a formatted date / "Invalid Date"
    e = e.replace(/new Date\((?:[^()]|\([^()]*\))*\)\.toLocale(Date|Time)?String\((?:[^()]|\([^()]*\))*\)/g, '0');
    e = e.replace(/\.(toLocaleString|toFixed|toLocaleDateString|toLocaleTimeString|length)\s*\([^()]*\)/g, '');
    e = e.replace(/[\w$.?]+\.length\b/g, '0'); // a count is a number
    // Only the parts that can end up in the output matter: ternary branches,
    // both sides of || / ??, the right side of &&, each operand of +.
    const outs = outputsOf(e).map(o => o.replace(/\b\d+(\.\d+)?\b/g, ''));
    const ids = outs.flatMap(o => o.match(/[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/g) || []).filter(id => !KEYWORDS.has(id) && !names.has(id));
    return ids.length ? { ok: false, ids } : { ok: true, why: 'encoded / literal / safe formatter' };
}

function isWrapped(e) {
    if (e[0] !== '(' || e[e.length - 1] !== ')') return false;
    let d = 0;
    for (let i = 0; i < e.length; i++) {
        if (e[i] === '(') d++; else if (e[i] === ')') { d--; if (d === 0 && i < e.length - 1) return false; }
    }
    return true;
}
const isQ = (s, i) => s[i] === '?' && s[i + 1] !== '.' && s[i + 1] !== '?' && s[i - 1] !== '?';
function splitTop(s, op) {
    const parts = []; let d = 0, last = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
        else if (d === 0 && s.startsWith(op, i)) {
            if (op === '+' && (s[i + 1] === '+' || s[i - 1] === '+' || s[i + 1] === '=')) continue;
            if (op === '?' && !isQ(s, i)) continue;
            parts.push(s.slice(last, i)); last = i + op.length; i += op.length - 1;
        }
    }
    parts.push(s.slice(last));
    return parts;
}
function outputsOf(e) {
    e = e.trim();
    while (e && isWrapped(e)) e = e.slice(1, -1).trim();
    let d = 0;
    for (let i = 0; i < e.length; i++) {
        const c = e[i];
        if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
        else if (d === 0 && isQ(e, i)) {
            const rest = e.slice(i + 1);
            let n = 0, dd = 0;
            for (let j = 0; j < rest.length; j++) {
                const r = rest[j];
                if ('([{'.includes(r)) dd++; else if (')]}'.includes(r)) dd--;
                else if (dd === 0 && isQ(rest, j)) n++;
                else if (dd === 0 && r === ':') { if (n === 0) return [...outputsOf(rest.slice(0, j)), ...outputsOf(rest.slice(j + 1))]; n--; }
            }
            return [rest];
        }
    }
    for (const op of ['||', '??']) { const p = splitTop(e, op); if (p.length > 1) return p.flatMap(outputsOf); }
    const a = splitTop(e, '&&'); if (a.length > 1) return outputsOf(a[a.length - 1]);
    const plus = splitTop(e, '+'); if (plus.length > 1) return plus.flatMap(outputsOf);
    return [e];
}

function topLevelIndex(s, ch) {
    let d = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) d--;
        else if (c === ch && d === 0 && s[i + 1] !== '.' && s[i + 1] !== '?' && s[i - 1] !== '?') return i;
    }
    return -1;
}

const findings = [];
const accepted = [];
for (const file of listFiles()) {
    const rel = relative(ROOT, file);
    if (rel === 'src/escape.js') continue;
    const js = scriptsOf(file, readFileSync(file, 'utf8'));
    const all = templates(js);
    const htmlish = t => /<\/?[a-zA-Z!]/.test(t.text) || /(innerHTML|outerHTML)\s*\+?=\s*$|insertAdjacentHTML\([^,]+,\s*$/.test(js.slice(Math.max(0, t.start - 60), t.start));
    const isHtml = new Set(all.filter(htmlish));
    // a template nested inside an HTML template is HTML too
    for (const t of all) if (!isHtml.has(t) && [...isHtml].some(h => h.start < t.start && h.end > t.end)) isHtml.add(t);
    for (const t of all) {
        if (!isHtml.has(t)) continue; // not HTML
        t.exprs.forEach((x, k) => {
            const r = classify(x.expr, rel);
            const line = lineOf(js, x.pos);
            const before = t.parts.slice(0, k + 1).join('\u0001');
            // inline event handler built with an interpolation: esc() is NOT
            // enough there (entities are decoded before the JS runs), so only
            // safeId() / Number() values are allowed.
            if (/\son[a-z]+\s*=\s*("[^"]*|'[^']*)$/i.test(before) && !classify(x.expr, rel, { inHandler: true }).ok) {
                findings.push({ rel, line, kind: 'inline-handler', expr: x.expr.trim() });
                return;
            }
            // URL attributes need a scheme check, not just HTML escaping.
            if (/\s(href|src|action|formaction|poster|srcset)\s*=\s*("[^"]*|'[^']*)$/i.test(before)) {
                const usesUrlEncoder = /\b(safeUrl|safeImageUrl|encodeURIComponent|safeId)\(/.test(x.expr);
                const literalOnly = classify(x.expr, rel, { inHandler: true }).ok;
                if (!usesUrlEncoder && !literalOnly && !(REVIEWED.safeUrlCalls?.[rel] || []).some(n => x.expr.trim().startsWith(n + '('))) {
                    findings.push({ rel, line, kind: 'url-attr', expr: x.expr.trim() });
                    return;
                }
            }
            if (r.ok) accepted.push({ rel, line, expr: x.expr.trim(), why: r.why });
            else findings.push({ rel, line, kind: 'unescaped', expr: x.expr.trim(), ids: r.ids });
        });
    }
    // non-template sinks
    const sinkRe = /(\.innerHTML|\.outerHTML)\s*\+?=(?!=)\s*([^;]+)|insertAdjacentHTML\s*\(\s*['"][^'"]+['"]\s*,\s*([^;]+)|document\.write(ln)?\s*\(([^;]+)/g;
    let m;
    while ((m = sinkRe.exec(js))) {
        const rhs = (m[2] || m[3] || m[5] || '').trim();
        if (/^[`'"]/.test(rhs)) continue; // literal / template → template check covers it
        if (/`/.test(rhs)) continue; // built from template literals → checked above
        if (/^[\w.?]+\.map\(/.test(rhs)) continue; // rows mapped to template literals → checked above
        if (/^bankOptionsHtml\(/.test(rhs)) continue; // static bank directory, escaped in src/ng-banks.js
        if (/^(esc|safe\w*|escapeHtml|escHtml)\(/.test(rhs)) continue;
        if (/^(''|""|``)/.test(rhs)) continue;
        findings.push({ rel, line: lineOf(js, m.index), kind: 'sink-review', expr: m[0].replace(/\s+/g, ' ').trim().slice(0, 160) });
    }
}

// URL sinks outside HTML strings: el.href / el.src / location / window.open /
// setAttribute('href'|'src'). Literal targets and safeUrl()/safeImageUrl()
// values pass; the rest must be listed in xss-reviewed.json "urlSinks".
const urlFindings = [];
for (const file of listFiles()) {
    const rel = relative(ROOT, file);
    if (rel === 'src/escape.js') continue;
    const js = scriptsOf(file, readFileSync(file, 'utf8'));
    const re = /\.(?:href|src)\s*=(?!=)\s*([^;\n]+)|\blocation(?:\.href)?\s*=(?!=)\s*([^;\n]+)|window\.open\(\s*([^,)\n]+)|setAttribute\(\s*['"](?:href|src)['"]\s*,\s*([^)\n]+)/g;
    let m;
    while ((m = re.exec(js))) {
        const rhs = (m[1] || m[2] || m[3] || m[4] || '').trim();
        if (/^['"`]/.test(rhs) && !/\$\{/.test(rhs.split('`')[1] || '')) continue; // literal
        if (/^`[\w./-]+\.html\?[\w=]*\$\{encodeURIComponent\(/.test(rhs)) continue; // own page + encoded param
        if (/^(safeUrl|safeImageUrl)\(/.test(rhs)) continue;
        const key = `${rel}: ${m[0].replace(/\s+/g, ' ').trim()}`;
        if ((REVIEWED.urlSinks || []).some(r => r.file === rel && key.includes(r.contains))) continue;
        urlFindings.push({ rel, line: lineOf(js, m.index), kind: 'url-sink', expr: m[0].replace(/\s+/g, ' ').trim().slice(0, 140) });
    }
}
findings.push(...urlFindings);

// sink-review entries that were checked by hand (rhs is built from escaped
// templates / fixed markup). Keep "file:snippet" keys narrow.
const REVIEWED_SINKS = REVIEWED.sinks || [];
const remaining = findings.filter(f => !(f.kind === 'sink-review' && REVIEWED_SINKS.some(r => r.file === f.rel && f.expr.includes(r.contains))));

if (VERBOSE) {
    console.log('Accepted interpolations:');
    for (const a of accepted) console.log(`  ${a.rel}:${a.line}  \${${a.expr}}  — ${a.why}`);
}
console.log(`Scanned ${listFiles().length} files; ${accepted.length} HTML interpolations accepted.`);
if (!remaining.length) { console.log('OK: no unescaped interpolations into HTML found.'); process.exit(0); }
console.log(`${remaining.length} finding(s):`);
for (const f of remaining) console.log(`  ${f.rel}:${f.line}  [${f.kind}]  ${f.kind === 'sink-review' || f.kind === 'url-sink' ? f.expr : '${' + f.expr + '}'}${f.ids ? '   ← ' + f.ids.join(', ') : ''}`);
process.exit(1);
