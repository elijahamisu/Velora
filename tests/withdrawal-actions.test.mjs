// Admin withdrawal actions (Send to gateway / Mark as paid / Reject) and
// deposit_mode routing. No network: Supabase and the gateway are stubbed.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// The real modules build a service-role client at import time; give them
// harmless dummies (the tests inject their own db and never use it).
process.env.SUPABASE_URL ||= 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-dummy-key';

const { createHandler: createWithdrawalsHandler, ACTIONS } = await import('../api/admin/withdrawals.js');
const { createHandler: createDepositHandler } = await import('../api/deposits/create.js');
const { depositMode } = await import('../api/_lib/afrstar.js');

const ENV = { AFRSTAR_MERCHANT_SN: 'MCH001', AFRSTAR_MERCHANT_AK: 'AK123', AFRSTAR_MERCHANT_SK: 'SK456', PUBLIC_SITE_URL: 'https://altivex.test' };
const ADMIN = { user: { id: 'admin-1' }, role: 'admin' };

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

// Tiny in-memory PostgREST look-alike: from().select/update/insert().eq/is().single/maybeSingle, rpc().
function fakeDb(tables, rpcImpl = () => null) {
  const rpcCalls = [];
  const updates = [];
  const db = {
    rpcCalls, updates, tables,
    from(table) {
      const filters = [];
      let patch = null; let inserted = null;
      const rows = () => (tables[table] ||= []).filter(r => filters.every(([c, v]) => (r[c] ?? null) === v));
      const run = () => {
        if (inserted) return inserted;
        if (patch) { const hit = rows(); hit.forEach(r => Object.assign(r, patch)); updates.push({ table, patch, n: hit.length }); return hit; }
        return rows();
      };
      const q = {
        select() { return q; },
        update(p) { patch = p; return q; },
        insert(arr) { inserted = arr.map((r, i) => ({ id: `${table}-${(tables[table] ||= []).length + i + 1}`, ...r })); tables[table].push(...inserted); return q; },
        eq(c, v) { filters.push([c, v]); return q; },
        is(c, v) { filters.push([c, v]); return q; },
        async single() { const r = run(); return r.length ? { data: r[0], error: null } : { data: null, error: { message: 'no rows' } }; },
        async maybeSingle() { return { data: run()[0] || null, error: null }; },
        then(ok, bad) { return Promise.resolve({ data: run(), error: null }).then(ok, bad); },
      };
      return q;
    },
    async rpc(name, args) { rpcCalls.push({ name, args }); return { data: await rpcImpl(name, args, tables), error: null }; },
  };
  return db;
}

// Mirrors admin_mark_withdrawal_paid / admin_reject_withdrawal (tests/withdrawal-actions.sql covers the real SQL).
function withdrawalRpc(name, { p_withdrawal }, t) {
  const w = t.withdrawals.find(x => x.id === p_withdrawal);
  if (!w) return { result: 'not_found' };
  if (name === 'admin_mark_withdrawal_paid') {
    if (w.status !== 'pending') return { result: 'conflict', status: w.status };
    w.status = 'approved'; w.method = 'manual';
    t.notifications.push({ user_id: w.user_id, title: 'Withdrawal Paid' });
    return { result: 'approved', status: 'approved' };
  }
  if (!(w.status === 'pending' || (w.status === 'processing' && !w.platform_osn))) return { result: 'conflict', status: w.status };
  w.status = 'rejected';
  t.wallets[w.user_id] += w.amount;
  return { result: 'rejected', status: 'rejected', refunded_balance: t.wallets[w.user_id] };
}

const pendingRow = (over = {}) => ({
  id: 'w1', user_id: 'u1', amount: 2000, charge: 300, status: 'pending', method: 'manual',
  bank_name: 'Access Bank', bank_code: '80000001', account_number: '0123456789', account_name: 'Ada Obi',
  platform_osn: null, order_sn: null, ...over,
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = await handler(url, init);
    return { ok: (r.status || 200) < 400, status: r.status || 200, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) };
  };
  f.calls = calls;
  return f;
}

const call = async (handler, body, method = 'POST') => { const res = mockRes(); await handler({ method, body, headers: {} }, res); return res; };

test('actions: send_gateway, mark_paid (+ complete alias), reject; anything else is 400', async () => {
  assert.deepEqual(ACTIONS.sort(), ['complete', 'mark_paid', 'reject', 'send_gateway']);
  const h = createWithdrawalsHandler({ db: fakeDb({}), authorize: async () => ADMIN, env: ENV });
  assert.equal((await call(h, { id: 'w1', action: 'approve' })).statusCode, 400);
  assert.equal((await call(h, { action: 'reject' })).statusCode, 400);
  assert.equal((await call(h, {}, 'GET')).statusCode, 405);
});

test('admin approval is required: a non-admin never reaches the database', async () => {
  const db = fakeDb({ withdrawals: [pendingRow()] }, withdrawalRpc);
  const h = createWithdrawalsHandler({ db, authorize: async (req, res) => { res.status(403).json({ error: 'Admins only.' }); return null; }, env: ENV });
  for (const action of ['send_gateway', 'mark_paid', 'reject']) {
    const r = await call(h, { id: 'w1', action });
    assert.equal(r.statusCode, 403);
  }
  assert.equal(db.rpcCalls.length, 0);
  assert.equal(db.updates.length, 0);
  assert.equal(db.tables.withdrawals[0].status, 'pending');
});

test('mark as paid: one locked RPC, no payout call, wallet untouched, user notified, second click is 409', async () => {
  const t = { withdrawals: [pendingRow()], wallets: { u1: 500 }, notifications: [] };
  const db = fakeDb(t, withdrawalRpc);
  const fetchImpl = fakeFetch(() => { throw new Error('gateway must not be called'); });
  const h = createWithdrawalsHandler({ db, authorize: async () => ADMIN, env: ENV, fetchImpl });
  const r = await call(h, { id: 'w1', action: 'mark_paid' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, status: 'approved', method: 'manual' });
  assert.deepEqual(db.rpcCalls, [{ name: 'admin_mark_withdrawal_paid', args: { p_withdrawal: 'w1', p_admin: 'admin-1' } }]);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(t.wallets.u1, 500);
  assert.equal(t.notifications.length, 1);
  const again = await call(h, { id: 'w1', action: 'mark_paid' });
  assert.equal(again.statusCode, 409);
  assert.match(again.body.error, /already approved/);
  // legacy alias
  t.withdrawals.push(pendingRow({ id: 'w2' }));
  assert.equal((await call(h, { id: 'w2', action: 'complete' })).body.status, 'approved');
});

test('reject: refund goes through admin_reject_withdrawal only (no read-then-write on wallets)', async () => {
  const t = { withdrawals: [pendingRow()], wallets: { u1: 500 }, notifications: [] };
  const db = fakeDb(t, withdrawalRpc);
  const h = createWithdrawalsHandler({ db, authorize: async () => ADMIN, env: ENV });
  const r = await call(h, { id: 'w1', action: 'reject' });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body, { ok: true, status: 'rejected', refundedBalance: 2500 });
  assert.equal(db.rpcCalls[0].name, 'admin_reject_withdrawal');
  assert.ok(!db.updates.some(u => u.table === 'wallets'), 'handler must not write wallets itself');
  const again = await call(h, { id: 'w1', action: 'reject' });
  assert.equal(again.statusCode, 409);
  assert.equal(t.wallets.u1, 2500, 'no double refund');
});

test('reject on processing rows: unknown outcome allowed, acknowledged payout refused', async () => {
  const t = {
    withdrawals: [pendingRow({ id: 'stuck', status: 'processing', method: 'gateway', order_sn: 'ALXW-1' }),
                  pendingRow({ id: 'acked', status: 'processing', method: 'gateway', order_sn: 'ALXW-2', platform_osn: 'osn' })],
    wallets: { u1: 0 }, notifications: [],
  };
  const h = createWithdrawalsHandler({ db: fakeDb(t, withdrawalRpc), authorize: async () => ADMIN, env: ENV });
  assert.equal((await call(h, { id: 'stuck', action: 'reject' })).statusCode, 200);
  const acked = await call(h, { id: 'acked', action: 'reject' });
  assert.equal(acked.statusCode, 409);
  assert.match(acked.body.error, /payout callback/);
  assert.equal((await call(h, { id: 'nope', action: 'reject' })).statusCode, 404);
});

test('send to gateway works even when deposits are Manual; claims pending -> processing and pays the net amount', async () => {
  const t = { site_settings: [{ id: 1, deposit_mode: 'manual', payment_mode: 'manual', site_name: 'Altivex' }], withdrawals: [pendingRow()] };
  const db = fakeDb(t);
  const fetchImpl = fakeFetch(() => ({ body: { code: 0, data: { platform_osn: 'axrjk', status: 'init' } } }));
  const h = createWithdrawalsHandler({ db, authorize: async () => ADMIN, env: ENV, fetchImpl });
  const r = await call(h, { id: 'w1', action: 'send_gateway' });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'processing');
  assert.equal(r.body.amount, '1700.00');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].body.amount, '1700.00');
  assert.equal(fetchImpl.calls[0].body.ifsc, '80000001');
  const w = t.withdrawals[0];
  assert.equal(w.status, 'processing');
  assert.equal(w.method, 'gateway');
  assert.equal(w.platform_osn, 'axrjk');
  assert.equal(w.sent_by, 'admin-1');
  assert.match(w.order_sn, /^ALXW-/);
  // already sent: no second payout
  const again = await call(h, { id: 'w1', action: 'send_gateway' });
  assert.equal(again.statusCode, 409);
  assert.equal(fetchImpl.calls.length, 1);
});

test('send to gateway: refused by gateway -> back to pending; timeout -> stays processing with warning', async () => {
  const t = { site_settings: [{ id: 1, deposit_mode: 'gateway' }], withdrawals: [pendingRow(), pendingRow({ id: 'w2' })] };
  const refuse = fakeFetch(() => ({ body: { code: 1, msg: 'Invalid account' } }));
  let h = createWithdrawalsHandler({ db: fakeDb(t), authorize: async () => ADMIN, env: ENV, fetchImpl: refuse });
  let r = await call(h, { id: 'w1', action: 'send_gateway' });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.status, 'pending');
  assert.equal(t.withdrawals[0].status, 'pending');
  assert.equal(t.withdrawals[0].order_sn, null);

  const down = fakeFetch(() => ({ status: 502, body: 'Bad gateway' }));
  h = createWithdrawalsHandler({ db: fakeDb(t), authorize: async () => ADMIN, env: ENV, fetchImpl: down });
  r = await call(h, { id: 'w2', action: 'send_gateway' });
  assert.equal(r.statusCode, 502);
  assert.equal(r.body.status, 'processing');
  assert.match(r.body.error, /may or may not have been created/);
  assert.equal(t.withdrawals[1].status, 'processing');
});

test('send to gateway: needs a valid bank code and NUBAN; missing config is 503', async () => {
  const t = { site_settings: [{ id: 1 }], withdrawals: [pendingRow({ bank_code: null, bank_name: 'Mystery Bank' }), pendingRow({ id: 'w2', account_number: '123' })] };
  const fetchImpl = fakeFetch(() => ({ body: { code: 0, data: {} } }));
  const h = createWithdrawalsHandler({ db: fakeDb(t), authorize: async () => ADMIN, env: ENV, fetchImpl });
  const noBank = await call(h, { id: 'w1', action: 'send_gateway' });
  assert.equal(noBank.statusCode, 422);
  assert.equal(noBank.body.code, 'bank_code_required');
  assert.equal((await call(h, { id: 'w2', action: 'send_gateway' })).statusCode, 422);
  assert.equal(fetchImpl.calls.length, 0);
  const noCfg = createWithdrawalsHandler({ db: fakeDb(t), authorize: async () => ADMIN, env: {} });
  assert.equal((await call(noCfg, { id: 'w1', action: 'send_gateway' })).statusCode, 503);
});

// ---------------- deposit_mode routing ----------------
test('depositMode(): deposit_mode first, legacy payment_mode fallback, manual by default', () => {
  assert.equal(depositMode({ deposit_mode: 'gateway', payment_mode: 'manual' }), 'gateway');
  assert.equal(depositMode({ deposit_mode: 'manual', payment_mode: 'gateway' }), 'manual');
  assert.equal(depositMode({ payment_mode: 'gateway' }), 'gateway');
  assert.equal(depositMode({}), 'manual');
  assert.equal(depositMode(null), 'manual');
  assert.equal(depositMode({ deposit_mode: 'weird' }), 'manual');
});

const USER = { user: { id: 'u1', email: 'ada@example.invalid' }, profile: { id: 'u1', full_name: 'Ada', email: 'ada@example.invalid', phone: '08011112222', role: 'user' } };

test('deposits/create: Manual deposit_mode refuses gateway checkout (even if legacy payment_mode says gateway)', async () => {
  const db = fakeDb({ site_settings: [{ id: 1, deposit_mode: 'manual', payment_mode: 'gateway', min_deposit: 3000 }], deposits: [] });
  const fetchImpl = fakeFetch(() => { throw new Error('must not call gateway'); });
  const h = createDepositHandler({ db, authorize: async () => USER, env: ENV, fetchImpl });
  const r = await call(h, { amount: 5000 });
  assert.equal(r.statusCode, 409);
  assert.match(r.body.error, /bank transfer/);
  assert.equal(db.tables.deposits.length, 0);
  assert.equal(fetchImpl.calls.length, 0);
});

test('deposits/create: Automatic deposit_mode creates the gateway order and returns pay_url', async () => {
  const db = fakeDb({ site_settings: [{ id: 1, deposit_mode: 'gateway', min_deposit: 3000 }], deposits: [] });
  const fetchImpl = fakeFetch(() => ({ body: { code: 0, data: { platform_osn: 'p1', pay_url: 'https://pay/p1' } } }));
  const h = createDepositHandler({ db, authorize: async () => USER, env: ENV, fetchImpl });
  const r = await call(h, { amount: 5000 });
  assert.equal(r.statusCode, 200, JSON.stringify(r.body));
  assert.equal(r.body.pay_url, 'https://pay/p1');
  assert.equal(db.tables.deposits.length, 1);
  assert.equal(db.tables.deposits[0].method, 'gateway');
  assert.match(fetchImpl.calls[0].body.redirect_url, /^https:\/\/altivex\.test\/deposit-result\.html\?ref=ALXD-/);
  assert.equal((await call(h, { amount: 100 })).statusCode, 400);
});
