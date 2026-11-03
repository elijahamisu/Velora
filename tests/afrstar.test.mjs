// Unit tests for the Afrstar integration. Run: node --test tests/
// No network: the gateway is stubbed with a fake fetch and Supabase with an
// in-memory fake. Keys below are dummies used only for signature vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  money, md5, signValues, sign, safeEqual, makeOrderSn, orderKind, PREFIX, getConfig,
  createPayin, createPayout, getBalance, post, parseCallbackBody, replyText,
} from '../api/_lib/afrstar.js';
import { handlePayinCallback, handlePayoutCallback } from '../api/_lib/afrstar-callbacks.js';
import { NG_BANKS, bankByCode, guessBankCode, isValidBankCode } from '../src/ng-banks.js';

const C = { ok: true, sn: 'MCH001', ak: 'AK123', sk: 'SK456' };
const ref = s => crypto.createHash('md5').update(s).digest('hex');

// ---------------- signing ----------------
test('md5 matches the doc example (AAA+BBB+CCC)', () => {
  assert.equal(md5('AAABBBCCC'), '6207b5df5796e963410d3bc4b6a4218b');
  assert.equal(signValues('AAA', 'BBB', 'CCC'), '6207b5df5796e963410d3bc4b6a4218b');
});

test('money() always gives two decimals', () => {
  assert.equal(money(500), '500.00');
  assert.equal(money('500'), '500.00');
  assert.equal(money('500.5'), '500.50');
  assert.equal(money(1234.565), '1234.57');
  assert.equal(money(0.1 + 0.2), '0.30');
  assert.equal(money(3000 * 1.11), '3330.00');
  assert.throws(() => money('abc'));
});

test('payin / payout / balance / callback signatures (known vectors)', () => {
  assert.equal(sign.payin(C, 'ALXD-20261103085412-9F3A1C7B', 500), '5f7f8c6ac7c5c19648f9929c27f8e709');
  assert.equal(sign.payin(C, 'ALXD-20261103085412-9F3A1C7B', '500.00'), '5f7f8c6ac7c5c19648f9929c27f8e709');
  assert.equal(sign.payout(C, 'ALXW-20261103085412-ABCDEF01', '0123456789', '', 850), 'c2894813abfc6d7c61addd72143efbd8');
  assert.equal(sign.balance(C), '5b92000b68a2760837377f8822bf9e4e');
  assert.equal(sign.payinCallback(C, 'abcde', 1, '500'), '95eac21be3509766e023e2f5933eb153');
  assert.equal(sign.payoutCallback(C, 'axrjk', 9, 850), '8b4e1a71367d791ebf4768a24ade132f');
  // cross-check against a plain md5 of the concatenation
  assert.equal(sign.balance(C), ref('AK123SK456'));
});

test('safeEqual is case-insensitive and rejects empty/different lengths', () => {
  assert.ok(safeEqual('ABCDEF', 'abcdef'));
  assert.ok(!safeEqual('', ''));
  assert.ok(!safeEqual('abc', 'abcd'));
});

test('order numbers: unique, <= 64 chars, routed by prefix', () => {
  const a = makeOrderSn(PREFIX.USER_DEPOSIT), b = makeOrderSn(PREFIX.USER_DEPOSIT);
  assert.notEqual(a, b);
  assert.ok(a.length <= 64);
  assert.equal(orderKind(a), 'USER_DEPOSIT');
  assert.equal(orderKind(makeOrderSn(PREFIX.ADMIN_TOPUP)), 'ADMIN_TOPUP');
  assert.equal(orderKind(makeOrderSn(PREFIX.USER_WITHDRAWAL)), 'USER_WITHDRAWAL');
  assert.equal(orderKind(makeOrderSn(PREFIX.ADMIN_PAYOUT)), 'ADMIN_PAYOUT');
  assert.equal(orderKind('ORDER-1'), null);
});

test('getConfig reports missing env names, never values', () => {
  const r = getConfig({ AFRSTAR_MERCHANT_SN: 'x' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['AFRSTAR_MERCHANT_AK', 'AFRSTAR_MERCHANT_SK']);
  assert.match(r.error, /not configured/);
  const ok = getConfig({ AFRSTAR_MERCHANT_SN: ' s ', AFRSTAR_MERCHANT_AK: 'a', AFRSTAR_MERCHANT_SK: 'k' });
  assert.equal(ok.ok, true);
  assert.equal(ok.sn, 's');
});

// ---------------- outgoing requests (fake fetch) ----------------
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const r = await responder(url, init);
    return { status: r.status ?? 200, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  fn.calls = calls;
  return fn;
}

test('createPayin sends the documented body and signature', async () => {
  const f = fakeFetch(() => ({ body: { code: 0, message: 'success', data: { platform_osn: 'abcde', pay_url: 'https://pay/abcde' } } }));
  const r = await createPayin(C, { orderSn: 'ALXD-1', amount: 3000, name: 'Ada', email: 'a@b.c', phone: '08011112222', remark: 'Dep', redirectUrl: 'https://x/r' }, { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.data.pay_url, 'https://pay/abcde');
  const { url, body } = f.calls[0];
  assert.equal(url, 'https://ngn.afrstar.com/gateway/payin/');
  assert.equal(body.amount, '3000.00');
  assert.equal(body.merchant_sn, 'MCH001');
  assert.equal(body.sign, ref('AK123' + 'ALXD-1' + '3000.00' + 'SK456'));
  for (const k of ['merchant_sn', 'order_sn', 'amount', 'name', 'email', 'phone', 'remark', 'redirect_url', 'sign']) assert.ok(k in body, k);
});

test('createPayout: type bank, bank code in ifsc, empty upi_handle in signature', async () => {
  const f = fakeFetch(() => ({ body: { code: 0, data: { platform_osn: 'axrjk', status: 'init' } } }));
  await createPayout(C, { orderSn: 'ALXW-1', amount: 850, name: 'Ada', account: '0123456789', bankCode: '80000030', remark: 'W' }, { fetchImpl: f });
  const { url, body } = f.calls[0];
  assert.equal(url, 'https://ngn.afrstar.com/gateway/payout/');
  assert.equal(body.type, 'bank');
  assert.equal(body.ifsc, '80000030');
  assert.equal(body.upi_handle, '');
  assert.equal(body.amount, '850.00');
  assert.equal(body.sign, ref('AK123' + 'ALXW-1' + '0123456789' + '' + '850.00' + 'SK456'));
});

test('getBalance body + parses balance', async () => {
  const f = fakeFetch(() => ({ body: { code: 0, data: { balance: '105.00' } } }));
  const r = await getBalance(C, { fetchImpl: f });
  assert.equal(r.data.balance, '105.00');
  assert.deepEqual(f.calls[0].body, { merchant_sn: 'MCH001', sign: ref('AK123SK456') });
});

test('post(): gateway errors are surfaced, timeouts are non-definitive', async () => {
  const ipBlock = await post('/gateway/balance/', {}, { fetchImpl: fakeFetch(() => ({ body: { code: 1003, message: 'IP not in whitelist: 1.2.3.4' } })) });
  assert.equal(ipBlock.ok, false);
  assert.equal(ipBlock.definitive, true);
  assert.match(ipBlock.message, /IP not in whitelist/);

  const html403 = await post('/gateway/balance/', {}, { fetchImpl: fakeFetch(() => ({ status: 403, body: '<html>Forbidden</html>' })) });
  assert.equal(html403.definitive, true);
  assert.match(html403.message, /HTTP 403/);

  const html502 = await post('/gateway/payout/', {}, { fetchImpl: fakeFetch(() => ({ status: 502, body: 'Bad gateway' })) });
  assert.equal(html502.definitive, false);

  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const t = await post('/gateway/payout/', {}, { fetchImpl: hang, timeoutMs: 50 });
  assert.equal(t.ok, false);
  assert.equal(t.definitive, false);
  assert.match(t.message, /No response/);
});

// ---------------- callbacks (stubbed Supabase) ----------------
function fakeDb(tables, rpcImpl) {
  const rpcCalls = [];
  return {
    rpcCalls,
    from(table) {
      const filters = [];
      const q = {
        select() { return q; },
        eq(col, val) { filters.push([col, val]); return q; },
        async maybeSingle() {
          const row = (tables[table] || []).find(r => filters.every(([c, v]) => r[c] === v)) || null;
          return { data: row, error: null };
        },
      };
      return q;
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      return { data: await rpcImpl(name, args), error: null };
    },
  };
}

// Mimics gateway_apply_payin's idempotency so repeated callbacks can be checked end-to-end.
function depositRpc(state) {
  return (name, a) => {
    const d = state.deposits.find(x => x.order_sn === a.p_order_sn);
    if (!d) return 'not_found';
    if (d.platform_osn && d.platform_osn !== a.p_platform_osn) return 'osn_mismatch';
    if (d.status === 'approved') return 'duplicate';
    if (a.p_status !== 1) { if (d.status === 'pending') { d.status = 'failed'; return 'failed_recorded'; } return 'ignored'; }
    const credit = a.p_amount_paid == null ? d.amount : Math.min(d.amount, a.p_amount_paid);
    d.status = 'approved'; d.credited = credit; state.wallet += credit;
    return 'credited';
  };
}

const payinBody = (over = {}) => {
  const b = { merchant_sn: 'MCH001', order_sn: 'ALXD-20261103-AAAA', platform_osn: 'abcde', status: 1, message: 'Paid Success', amount: '5000.00', amount_need: '5000.00', amount_paid: '5000.00', utr: 'U1', ...over };
  b.sign = over.sign ?? sign.payinCallback(C, b.platform_osn, b.status, '5000.00');
  return b;
};

test('payin callback: valid -> "success" and credits once; retries do not credit again', async () => {
  const state = { wallet: 0, deposits: [{ id: 'd1', order_sn: 'ALXD-20261103-AAAA', amount: 5000, method: 'gateway', status: 'pending', platform_osn: 'abcde' }] };
  const db = fakeDb({ deposits: state.deposits }, depositRpc(state));
  const r1 = await handlePayinCallback({ body: payinBody(), db, config: C });
  assert.deepEqual([r1.status, r1.text, r1.result], [200, 'success', 'credited']);
  const r2 = await handlePayinCallback({ body: payinBody(), db, config: C });
  assert.deepEqual([r2.status, r2.text, r2.result], [200, 'success', 'duplicate']);
  assert.equal(state.wallet, 5000);
  assert.equal(db.rpcCalls[0].name, 'gateway_apply_payin');
  assert.equal(db.rpcCalls[0].args.p_amount_paid, 5000);
});

test('payin callback: signature uses the STORED order amount, not the paid amount', async () => {
  const state = { wallet: 0, deposits: [{ id: 'd1', order_sn: 'ALXD-20261103-AAAA', amount: 5000, method: 'gateway', status: 'pending' }] };
  const db = fakeDb({ deposits: state.deposits }, depositRpc(state));
  // Partial payment: amount/amount_paid 3000, signed over the original 5000.00
  const ok = await handlePayinCallback({ body: payinBody({ amount: '3000.00', amount_paid: '3000.00' }), db, config: C });
  assert.equal(ok.text, 'success');
  assert.equal(state.wallet, 3000);
  // Someone signing over the paid amount instead is rejected.
  const state2 = { wallet: 0, deposits: [{ id: 'd2', order_sn: 'ALXD-20261103-AAAA', amount: 5000, method: 'gateway', status: 'pending' }] };
  const db2 = fakeDb({ deposits: state2.deposits }, depositRpc(state2));
  const bad = await handlePayinCallback({ body: payinBody({ amount_paid: '3000.00', sign: sign.payinCallback(C, 'abcde', 1, '3000.00') }), db: db2, config: C });
  assert.equal(bad.status, 401);
  assert.notEqual(bad.text, 'success');
  assert.equal(db2.rpcCalls.length, 0);
});

test('payin callback rejects bad signature, wrong merchant, unknown order, missing fields, missing config', async () => {
  const state = { wallet: 0, deposits: [{ id: 'd1', order_sn: 'ALXD-20261103-AAAA', amount: 5000, method: 'gateway', status: 'pending' }] };
  const db = fakeDb({ deposits: state.deposits }, depositRpc(state));
  const cases = [
    [payinBody({ sign: '0'.repeat(32) }), 401],
    [payinBody({ merchant_sn: 'OTHER' }), 400],
    [payinBody({ order_sn: 'ALXD-UNKNOWN' }), 404],
    [payinBody({ order_sn: 'RANDOM-1' }), 404],
    [{ order_sn: 'ALXD-20261103-AAAA' }, 400],
  ];
  for (const [body, code] of cases) {
    const r = await handlePayinCallback({ body, db, config: C });
    assert.equal(r.status, code, JSON.stringify(body));
    assert.notEqual(r.text, 'success');
  }
  const nc = await handlePayinCallback({ body: payinBody(), db, config: { ok: false } });
  assert.equal(nc.status, 500);
  assert.equal(state.wallet, 0);
  assert.equal(db.rpcCalls.length, 0);
});

test('payin callback: non-1 status is acknowledged but never credits', async () => {
  const state = { wallet: 0, deposits: [{ id: 'd1', order_sn: 'ALXD-20261103-AAAA', amount: 5000, method: 'gateway', status: 'pending' }] };
  const db = fakeDb({ deposits: state.deposits }, depositRpc(state));
  const r = await handlePayinCallback({ body: payinBody({ status: 2, sign: sign.payinCallback(C, 'abcde', 2, 5000) }), db, config: C });
  assert.deepEqual([r.status, r.text, r.result], [200, 'success', 'failed_recorded']);
  assert.equal(state.wallet, 0);
});

test('payin callback: manual deposits cannot be completed through the gateway', async () => {
  const db = fakeDb({ deposits: [{ id: 'd1', order_sn: 'ALXD-20261103-AAAA', amount: 5000, method: 'manual', status: 'pending' }] }, () => 'credited');
  const r = await handlePayinCallback({ body: payinBody(), db, config: C });
  assert.equal(r.status, 404);
  assert.equal(db.rpcCalls.length, 0);
});

test('payin callback: admin top-up routes to gateway_apply_admin, not a wallet', async () => {
  const db = fakeDb({ gateway_admin_transactions: [{ id: 'g1', order_sn: 'ALXAT-20261103-BBBB', amount: 20000, kind: 'topup' }] }, () => 'completed');
  const body = { merchant_sn: 'MCH001', order_sn: 'ALXAT-20261103-BBBB', platform_osn: 'tp1', status: 1, amount: '20000.00', amount_paid: '20000.00' };
  body.sign = sign.payinCallback(C, 'tp1', 1, 20000);
  const r = await handlePayinCallback({ body, db, config: C });
  assert.equal(r.text, 'success');
  assert.equal(db.rpcCalls[0].name, 'gateway_apply_admin');
  assert.equal(db.rpcCalls[0].args.p_kind, 'topup');
});

// Mimics gateway_apply_payout.
function payoutRpc(state) {
  return (name, a) => {
    const w = state.withdrawals.find(x => x.order_sn === a.p_order_sn);
    if (!w) return 'not_found';
    if (['approved', 'failed', 'rejected'].includes(w.status)) return 'duplicate';
    if (a.p_status === 1) { w.status = 'approved'; return 'completed'; }
    if (a.p_status === 9) { w.status = 'failed'; state.wallet += w.amount; return 'refunded'; }
    return 'ignored';
  };
}
const payoutBody = (over = {}) => {
  const b = { merchant_sn: 'MCH001', order_sn: 'ALXW-20261103-CCCC', platform_osn: 'axrjk', status: 1, utr: 'T1', name: 'Ada', message: 'Transfered Success', amount: '850.00', time_transfered: '2026-11-03 10:35:00', ...over };
  b.sign = over.sign ?? sign.payoutCallback(C, b.platform_osn, b.status, b.amount);
  return b;
};

test('payout callback: 1 completes once; 9 refunds once', async () => {
  const state = { wallet: 0, withdrawals: [
    { id: 'w1', order_sn: 'ALXW-20261103-CCCC', amount: 1000, payout_amount: 850, status: 'processing' },
    { id: 'w2', order_sn: 'ALXW-20261103-DDDD', amount: 2000, payout_amount: 1700, status: 'processing' },
  ] };
  const db = fakeDb({ withdrawals: state.withdrawals }, payoutRpc(state));
  assert.deepEqual(await handlePayoutCallback({ body: payoutBody(), db, config: C }), { status: 200, text: 'success', result: 'completed' });
  assert.equal((await handlePayoutCallback({ body: payoutBody(), db, config: C })).result, 'duplicate');
  const f = payoutBody({ order_sn: 'ALXW-20261103-DDDD', status: 9, amount: '1700.00', message: 'Invalid account' });
  assert.equal((await handlePayoutCallback({ body: f, db, config: C })).result, 'refunded');
  assert.equal((await handlePayoutCallback({ body: f, db, config: C })).result, 'duplicate');
  assert.equal(state.wallet, 2000);
});

test('payout callback rejects bad signature and amount mismatch', async () => {
  const state = { wallet: 0, withdrawals: [{ id: 'w1', order_sn: 'ALXW-20261103-CCCC', amount: 1000, payout_amount: 850, status: 'processing' }] };
  const db = fakeDb({ withdrawals: state.withdrawals }, payoutRpc(state));
  const bad = await handlePayoutCallback({ body: payoutBody({ sign: 'f'.repeat(32) }), db, config: C });
  assert.equal(bad.status, 401);
  const mismatch = await handlePayoutCallback({ body: payoutBody({ amount: '900.00' }), db, config: C }); // validly signed, wrong amount
  assert.equal(mismatch.status, 409);
  assert.notEqual(mismatch.text, 'success');
  assert.equal(db.rpcCalls.length, 0);
  assert.equal(state.withdrawals[0].status, 'processing');
});

test('payout callback: admin payout (ALXAP) routes to gateway_apply_admin', async () => {
  const db = fakeDb({ gateway_admin_transactions: [{ id: 'g1', order_sn: 'ALXAP-20261103-EEEE', amount: 10000, kind: 'payout' }] }, () => 'completed');
  const body = payoutBody({ order_sn: 'ALXAP-20261103-EEEE', amount: '10000.00', platform_osn: 'ap1' });
  const r = await handlePayoutCallback({ body, db, config: C });
  assert.equal(r.text, 'success');
  assert.equal(db.rpcCalls[0].args.p_kind, 'payout');
});

// ---------------- HTTP plumbing ----------------
test('replyText writes exactly "success" with no newline', () => {
  const res = { headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b; } };
  replyText(res, 200, 'success');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'success');
  assert.equal(Buffer.byteLength(res.body), 7);
  assert.match(res.headers['content-type'], /^text\/plain/);
});

test('parseCallbackBody accepts JSON objects, JSON strings and form bodies', () => {
  assert.deepEqual(parseCallbackBody({ body: { a: 1 } }), { a: 1 });
  assert.deepEqual(parseCallbackBody({ body: '{"a":1}' }), { a: 1 });
  assert.deepEqual(parseCallbackBody({ body: 'a=1&b=x' }), { a: '1', b: 'x' });
  assert.deepEqual(parseCallbackBody({ body: Buffer.from('{"a":2}') }), { a: 2 });
});

// ---------------- banks ----------------
test('bank list: 142 unique 8-digit codes, lookups and name mapping', () => {
  assert.equal(NG_BANKS.length, 142);
  assert.equal(new Set(NG_BANKS.map(b => b.code)).size, 142);
  assert.ok(NG_BANKS.every(b => /^\d{8}$/.test(b.code)));
  assert.equal(bankByCode('80000030').name, 'OPay');
  assert.ok(isValidBankCode('80000183'));
  assert.ok(!isValidBankCode('80000031'));
  const map = { 'GTBank': '80000009', 'gtb': '80000009', 'Opay': '80000030', 'OPAY DIGITAL SERVICES': '80000030', 'Kuda': '80000028', 'First Bank': '80000007', 'UBA': '80000022',
    'Palmpay': '80000033', 'Moniepoint': '80000029', 'Access Bank Plc': '80000001', 'Zenith bank': '80000025', 'FCMB': '80000008', 'Stanbic IBTC': '80000017', 'wema': '80000024' };
  for (const [n, c] of Object.entries(map)) assert.equal(guessBankCode(n), c, n);
  assert.equal(guessBankCode('Some Unknown MFB'), null);
  assert.equal(guessBankCode(''), null);
});
