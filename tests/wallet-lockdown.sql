-- Wallet lockdown checks. Runs entirely inside one transaction and ROLLS BACK.
-- Run with the Supabase SQL endpoint (as postgres). The final block raises an
-- exception carrying the JSON results, which also aborts the transaction.
begin;
create temp table r(n serial, step text, val text);
grant all on r to authenticated, anon, service_role; grant usage on sequence r_n_seq to authenticated, anon, service_role;
create temp table ids(k text primary key, id uuid);
grant all on ids to authenticated, anon, service_role;

-- Fixtures (as postgres): two users, a plan, a gift code, open withdrawals.
do $$
declare u uuid := gen_random_uuid(); v uuid := gen_random_uuid(); pl uuid; adm uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','lock-u@example.invalid','{"full_name":"Lock U"}', now(), now()),
         (v, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','lock-v@example.invalid','{"full_name":"Lock V"}', now(), now());
  insert into r(step,val) values ('handle_new_user made wallets', (select count(*)::text from wallets where user_id in (u,v)));
  update wallets set available_balance = 10000, bonus_balance = 0 where user_id in (u, v);
  insert into investment_plans (name, category, price, daily_roi_pct, duration_days, is_active)
  values ('LockTest Plan', 'starter', 3000, 10, 5, true) returning id into pl;
  insert into investment_plans (name, category, price, daily_roi_pct, duration_days, is_active)
  values ('LockTest Pro', 'professional', 2000, 10, 5, true) returning id into adm;
  insert into ids values ('u', u), ('v', v), ('plan', pl), ('proplan', adm);
  insert into gift_codes (code, amount, usage_limit, current_usage, is_active) values ('LOCKTEST-GIFT', 500, 5, 0, true);
  insert into gift_codes (code, amount, usage_limit, current_usage, is_active) values ('LOCKTEST-OLD', 500, 5, 0, true);
  update gift_codes set expiry_date = now() - interval '1 day' where code = 'LOCKTEST-OLD';
  update site_settings set withdrawal_days = '{0,1,2,3,4,5,6}', withdrawal_open_time = '00:00', withdrawal_close_time = '23:59',
         min_withdrawal = 600, max_withdrawal = null, withdrawal_fee_pct = 15, min_deposit = 3000, max_deposit = null where id = 1;
end $$;

-- ===== As user U =====
select set_config('request.jwt.claims', json_build_object('sub', (select ids.id from ids where k='u'), 'role','authenticated')::text, true);
set local role authenticated;

do $$
declare u uuid := auth.uid(); v uuid := (select ids.id from ids where k='v'); n int; res text;
begin
  -- direct writes to wallets
  begin update wallets set available_balance = 999999 where user_id = u; get diagnostics n = row_count;
        insert into r(step,val) values ('direct wallet UPDATE own', 'ALLOWED rows='||n);
  exception when others then insert into r(step,val) values ('direct wallet UPDATE own', 'denied: '||sqlerrm); end;
  begin insert into wallets(user_id, available_balance) values (gen_random_uuid(), 1e6);
        insert into r(step,val) values ('direct wallet INSERT', 'ALLOWED');
  exception when others then insert into r(step,val) values ('direct wallet INSERT', 'denied: '||sqlerrm); end;
  begin delete from wallets where user_id = u; insert into r(step,val) values ('direct wallet DELETE', 'ALLOWED');
  exception when others then insert into r(step,val) values ('direct wallet DELETE', 'denied: '||sqlerrm); end;
  insert into r(step,val) values ('wallet SELECT own still works', (select available_balance::text from wallets where user_id = u));
  insert into r(step,val) values ('wallet SELECT other user hidden', (select count(*)::text from wallets where user_id = v));

  -- other forged writes
  begin perform increment_balance(u, 100000); insert into r(step,val) values ('rpc increment_balance', 'ALLOWED');
  exception when others then insert into r(step,val) values ('rpc increment_balance', 'denied: '||sqlerrm); end;
  begin perform process_daily_earnings(); insert into r(step,val) values ('rpc process_daily_earnings', 'ALLOWED');
  exception when others then insert into r(step,val) values ('rpc process_daily_earnings', 'denied: '||sqlerrm); end;
  begin insert into investments(user_id, plan_id, amount_invested, daily_earning_amount, remaining_days) values (u, null, 1, 1e6, 365);
        insert into r(step,val) values ('direct investments INSERT', 'ALLOWED');
  exception when others then insert into r(step,val) values ('direct investments INSERT', 'denied: '||sqlerrm); end;
  begin insert into transactions(user_id, amount, type, description) values (u, 1e6, 'referral_bonus', 'fake');
        insert into r(step,val) values ('direct transactions INSERT', 'ALLOWED');
  exception when others then insert into r(step,val) values ('direct transactions INSERT', 'denied: '||sqlerrm); end;
  begin insert into withdrawals(user_id, amount, bank_name, account_number, account_name) values (u, 5000, 'X', '0123456789', 'Y');
        insert into r(step,val) values ('direct withdrawals INSERT', 'ALLOWED');
  exception when others then insert into r(step,val) values ('direct withdrawals INSERT', 'denied: '||sqlerrm); end;
  begin insert into deposits(user_id, amount, account_name, bank_name) values (u, 5000, 'X', 'Y');
        insert into r(step,val) values ('direct deposits INSERT', 'ALLOWED');
  exception when others then insert into r(step,val) values ('direct deposits INSERT', 'denied: '||sqlerrm); end;
  begin insert into notifications(user_id, title, message) values (u, 'fake', 'fake');
        insert into r(step,val) values ('direct notifications INSERT', 'ALLOWED');
  exception when others then insert into r(step,val) values ('direct notifications INSERT', 'denied: '||sqlerrm); end;
  insert into r(step,val) values ('gift_codes visible to user', (select count(*)::text from gift_codes));
  begin update gift_codes set current_usage = 0, amount = 1e6; get diagnostics n = row_count;
        insert into r(step,val) values ('direct gift_codes UPDATE', 'rows='||n);
  exception when others then insert into r(step,val) values ('direct gift_codes UPDATE', 'denied: '||sqlerrm); end;
  begin perform admin_set_wallet(u, 1e6, null, null, null, null, null, null, 'x'); insert into r(step,val) values ('rpc admin_set_wallet as user', 'ALLOWED');
  exception when others then insert into r(step,val) values ('rpc admin_set_wallet as user', 'denied: '||sqlerrm); end;
  update profiles set role = 'admin', status = 'active', referred_by = v, referral_code = 'HACKED', email = 'x@x', full_name = 'Lock U2' where id = u;
  insert into r(step,val) values ('profile edit (only full_name may change)',
    (select role||'|'||coalesce(referred_by::text,'null')||'|'||referral_code||'|'||email||'|'||full_name from profiles where id = u));

  -- RPCs: failures
  begin perform user_request_withdrawal(1000, 'Bank', '00000014', '0123456789', 'Lock U');
        insert into r(step,val) values ('withdraw w/o active investment', 'ALLOWED');
  exception when others then insert into r(step,val) values ('withdraw w/o active investment', 'refused: '||sqlerrm); end;
  begin perform user_invest((select ids.id from ids where k='proplan'));
        insert into r(step,val) values ('invest professional w/o active', 'ALLOWED');
  exception when others then insert into r(step,val) values ('invest professional w/o active', 'refused: '||sqlerrm); end;
  begin perform user_invest((select ids.id from ids where k='plan'), 1);
        insert into r(step,val) values ('invest with wrong amount', 'ALLOWED');
  exception when others then insert into r(step,val) values ('invest with wrong amount', 'refused: '||sqlerrm); end;

  -- RPCs: success
  insert into r(step,val) values ('user_invest ok', ((select user_invest((select ids.id from ids where k='plan'))) is not null)::text);
  insert into r(step,val) values ('after invest balance (exp 7000)', (select available_balance::text from wallets where user_id = u));
  insert into r(step,val) values ('investment row', (select amount_invested||'/'||daily_earning_amount||'/'||remaining_days||'/'||status from investments where user_id = u));

  begin perform user_request_withdrawal(8000, 'Bank', '00000014', '0123456789', 'Lock U');
        insert into r(step,val) values ('withdraw overdraw 8000', 'ALLOWED');
  exception when others then insert into r(step,val) values ('withdraw overdraw 8000', 'refused: '||sqlerrm); end;
  begin perform user_request_withdrawal(100, 'Bank', '00000014', '0123456789', 'Lock U');
        insert into r(step,val) values ('withdraw below min', 'ALLOWED');
  exception when others then insert into r(step,val) values ('withdraw below min', 'refused: '||sqlerrm); end;
  begin perform user_request_withdrawal(1000, 'Bank', '00000014', '12345', 'Lock U');
        insert into r(step,val) values ('withdraw bad account no', 'ALLOWED');
  exception when others then insert into r(step,val) values ('withdraw bad account no', 'refused: '||sqlerrm); end;
  perform user_request_withdrawal(2000, 'Access Bank', '00000014', '0123456789', 'Lock U');
  insert into r(step,val) values ('withdraw 2000 ok -> balance (exp 5000)', (select available_balance::text from wallets where user_id = u));
  insert into r(step,val) values ('withdrawal row', (select amount||'/'||charge||'/'||status||'/'||method||'/'||coalesce(bank_code,'null') from withdrawals where user_id = u));
  insert into r(step,val) values ('withdrawal tx+notif', (select count(*)::text from transactions where user_id = u and type='withdrawal')||'/'||(select count(*)::text from notifications where user_id = u and title='Withdrawal Pending'));
  begin delete from withdrawals where user_id = u; get diagnostics n = row_count; insert into r(step,val) values ('user delete own pending withdrawal', 'rows='||n);
  exception when others then insert into r(step,val) values ('user delete own pending withdrawal', 'denied: '||sqlerrm); end;

  begin perform user_redeem_gift_code('NOPE-CODE'); insert into r(step,val) values ('gift bad code', 'ALLOWED');
  exception when others then insert into r(step,val) values ('gift bad code', 'refused: '||sqlerrm); end;
  begin perform user_redeem_gift_code('LOCKTEST-OLD'); insert into r(step,val) values ('gift expired', 'ALLOWED');
  exception when others then insert into r(step,val) values ('gift expired', 'refused: '||sqlerrm); end;
  insert into r(step,val) values ('gift ok (lowercase input)', user_redeem_gift_code(' locktest-gift ')::text);
  insert into r(step,val) values ('after gift balance (exp 5500)', (select available_balance::text from wallets where user_id = u));
  begin perform user_redeem_gift_code('LOCKTEST-GIFT'); insert into r(step,val) values ('gift double redeem', 'ALLOWED');
  exception when others then insert into r(step,val) values ('gift double redeem', 'refused: '||sqlerrm); end;
  begin delete from gift_redemptions where user_id = u; get diagnostics n = row_count; insert into r(step,val) values ('user delete own redemption', 'rows='||n);
  exception when others then insert into r(step,val) values ('user delete own redemption', 'denied: '||sqlerrm); end;

  insert into r(step,val) values ('deposit request ok', (user_create_deposit(4000, 'Lock U', 'GTB') is not null)::text);
  insert into r(step,val) values ('deposit row', (select amount||'/'||status||'/'||method from deposits where user_id = u));
  begin perform user_create_deposit(100, 'Lock U', 'GTB'); insert into r(step,val) values ('deposit below min', 'ALLOWED');
  exception when others then insert into r(step,val) values ('deposit below min', 'refused: '||sqlerrm); end;

  update notifications set is_read = true where user_id = u; get diagnostics n = row_count;
  insert into r(step,val) values ('mark notifications read', 'rows='||n);
  begin update notifications set title = 'forged' where user_id = u; insert into r(step,val) values ('edit notification title', 'ALLOWED');
  exception when others then insert into r(step,val) values ('edit notification title', 'denied: '||sqlerrm); end;
end $$;

reset role;
-- ===== Closed window + inactive user (as postgres change settings, then as U) =====
select set_config('request.jwt.claims', '', true);
update site_settings set withdrawal_days = '{}' where id = 1;
select set_config('request.jwt.claims', json_build_object('sub', (select ids.id from ids where k='u'), 'role','authenticated')::text, true);
set local role authenticated;
do $$ begin
  begin perform user_request_withdrawal(1000, 'Bank', '00000014', '0123456789', 'Lock U'); insert into r(step,val) values ('withdraw closed day', 'ALLOWED');
  exception when others then insert into r(step,val) values ('withdraw closed day', 'refused: '||sqlerrm); end;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
update site_settings set withdrawal_days = '{0,1,2,3,4,5,6}' where id = 1;
update profiles set status = 'suspended' where id = (select ids.id from ids where k='u');
insert into r(step,val) values ('(fixture) U suspended', (select status from profiles where id = (select ids.id from ids where k='u')));
select set_config('request.jwt.claims', json_build_object('sub', (select ids.id from ids where k='u'), 'role','authenticated')::text, true);
set local role authenticated;
do $$ begin
  begin perform user_request_withdrawal(1000, 'Bank', '00000014', '0123456789', 'Lock U'); insert into r(step,val) values ('withdraw suspended', 'ALLOWED');
  exception when others then insert into r(step,val) values ('withdraw suspended', 'refused: '||sqlerrm); end;
  begin perform user_invest((select ids.id from ids where k='plan')); insert into r(step,val) values ('invest suspended', 'ALLOWED');
  exception when others then insert into r(step,val) values ('invest suspended', 'refused: '||sqlerrm); end;
  begin perform user_redeem_gift_code('LOCKTEST-GIFT'); insert into r(step,val) values ('gift suspended', 'ALLOWED');
  exception when others then insert into r(step,val) values ('gift suspended', 'refused: '||sqlerrm); end;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
update profiles set status = 'active' where id = (select ids.id from ids where k='u');

-- anon cannot call user RPCs
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$ begin
  begin perform user_invest((select ids.id from ids where k='plan')); insert into r(step,val) values ('anon user_invest', 'ALLOWED');
  exception when others then insert into r(step,val) values ('anon user_invest', 'denied: '||sqlerrm); end;
  begin update wallets set available_balance = 1; insert into r(step,val) values ('anon wallet update', 'ALLOWED');
  exception when others then insert into r(step,val) values ('anon wallet update', 'denied: '||sqlerrm); end;
end $$;
reset role;

-- ===== Admin paths =====
select set_config('request.jwt.claims', json_build_object('sub', (select id from profiles where role in ('admin','super_admin') order by created_at limit 1), 'role','authenticated')::text, true);
set local role authenticated;
do $$
declare u uuid := (select ids.id from ids where k='u'); d uuid;
begin
  perform admin_set_wallet(u, 12345, null, null, null, null, null, null, 'lock test');
  insert into r(step,val) values ('admin_set_wallet (exp 12345)', (select available_balance::text from wallets where user_id = u));
  select id into d from deposits where user_id = u and status = 'pending' limit 1;
  perform admin_approve_deposit(d);
  insert into r(step,val) values ('admin_approve_deposit (exp 16345)', (select available_balance::text from wallets where user_id = u));
  insert into r(step,val) values ('admin reads all gift codes', (select (count(*) >= 2)::text from gift_codes));
  update gift_codes set is_active = false where code = 'LOCKTEST-OLD';
  insert into r(step,val) values ('admin toggles gift code', (select (not is_active)::text from gift_codes where code = 'LOCKTEST-OLD'));
  insert into transactions(user_id, amount, type, description) values (u, 1, 'admin_credit', 'admin manual tx');
  insert into notifications(user_id, title, message) values (u, 'Admin note', 'hi');
  update investments set remaining_days = 4 where user_id = u;
  insert into r(step,val) values ('admin tx/notif/investment writes', 'ok');
  update profiles set status = 'suspended', referral_code = referral_code where id = u;
  insert into r(step,val) values ('admin sets status', (select status from profiles where id = u));
  update profiles set status = 'active' where id = u;
end $$;
reset role;

-- ===== Service role (gateway / admin API) and cron =====
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare u uuid := (select ids.id from ids where k='u'); w uuid;
begin
  select id into w from withdrawals where user_id = u limit 1;
  update withdrawals set status = 'rejected', processed_at = now() where id = w and status = 'pending';
  update wallets set available_balance = available_balance + 2000 where user_id = u;
  insert into r(step,val) values ('service_role reject+refund (exp 18345)', (select available_balance::text from wallets where user_id = u));
end $$;
reset role;
select set_config('request.jwt.claims', '', true);
do $$
declare u uuid := (select ids.id from ids where k='u');
begin
  update investments set last_paid_at = null where user_id = u;
  perform process_daily_earnings();
  insert into r(step,val) values ('cron process_daily_earnings, 1 investment x 300 (exp 18645)', (select available_balance::text from wallets where user_id = u));
end $$;

-- Report by aborting (guarantees rollback even if the runner auto-commits).
do $$ begin raise exception 'RESULTS %', (select json_agg(json_build_object('step', step, 'val', val) order by n) from r); end $$;
rollback;
