-- Deposit mode split + admin withdrawal actions (Mark as paid / Reject & refund).
-- Runs inside one transaction and ROLLS BACK (the final block raises an
-- exception carrying the JSON results, which also aborts the transaction).
-- Run with the Supabase SQL endpoint (as postgres).
begin;
create temp table r(n serial, step text, val text);
grant all on r to authenticated, anon, service_role; grant usage on sequence r_n_seq to authenticated, anon, service_role;
create temp table ids(k text primary key, id uuid);
grant all on ids to authenticated, anon, service_role;

-- ===== deposit_mode <-> payment_mode sync =====
do $$
begin
  update site_settings set deposit_mode = 'manual' where id = 1;
  insert into r(step,val) values ('set deposit_mode manual -> both', (select deposit_mode||'/'||payment_mode from site_settings where id = 1));
  update site_settings set deposit_mode = 'gateway' where id = 1;
  insert into r(step,val) values ('set deposit_mode gateway -> both', (select deposit_mode||'/'||payment_mode from site_settings where id = 1));
  update site_settings set payment_mode = 'manual' where id = 1;
  insert into r(step,val) values ('legacy payment_mode manual -> both', (select deposit_mode||'/'||payment_mode from site_settings where id = 1));
  update site_settings set deposit_mode = 'gateway' where id = 1;
  update site_settings set payment_mode = 'gateway', deposit_mode = 'manual' where id = 1;
  insert into r(step,val) values ('both changed: deposit_mode wins (exp manual/manual)', (select deposit_mode||'/'||payment_mode from site_settings where id = 1));
  begin update site_settings set deposit_mode = 'auto' where id = 1; insert into r(step,val) values ('invalid deposit_mode', 'ALLOWED');
  exception when others then insert into r(step,val) values ('invalid deposit_mode', 'refused'); end;
  update site_settings set site_name = site_name where id = 1;
  insert into r(step,val) values ('unrelated update keeps mode (exp manual/manual)', (select deposit_mode||'/'||payment_mode from site_settings where id = 1));
end $$;

-- ===== Fixtures =====
do $$
declare u uuid := gen_random_uuid(); adm uuid;
begin
  select id into adm from profiles where role in ('admin','super_admin') limit 1;
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','wd-actions@example.invalid','{"full_name":"WD Actions"}', now(), now());
  update wallets set available_balance = 1000 where user_id = u;
  insert into ids values ('u', u), ('adm', adm);
  -- A: pending (mark paid)   B: pending (reject)   C: processing, gateway acknowledged
  -- D: processing, outcome unknown (no platform_osn)   E: already approved
  insert into withdrawals(user_id, amount, charge, bank_name, bank_code, account_number, account_name, status, method)
  values (u, 2000, 300, 'Access Bank', '80000001', '0123456789', 'WD Actions', 'pending', 'manual') returning id into adm;
  insert into ids values ('A', adm);
  insert into withdrawals(user_id, amount, charge, bank_name, bank_code, account_number, account_name, status, method)
  values (u, 3000, 450, 'Access Bank', '80000001', '0123456789', 'WD Actions', 'pending', 'manual') returning id into adm;
  insert into ids values ('B', adm);
  insert into withdrawals(user_id, amount, charge, bank_name, bank_code, account_number, account_name, status, method, order_sn, platform_osn, payout_amount)
  values (u, 4000, 600, 'Access Bank', '80000001', '0123456789', 'WD Actions', 'processing', 'gateway', 'ALXW-WDT-C', 'osnC', 3400) returning id into adm;
  insert into ids values ('C', adm);
  insert into withdrawals(user_id, amount, charge, bank_name, bank_code, account_number, account_name, status, method, order_sn, payout_amount)
  values (u, 5000, 750, 'Access Bank', '80000001', '0123456789', 'WD Actions', 'processing', 'gateway', 'ALXW-WDT-D', 4250) returning id into adm;
  insert into ids values ('D', adm);
  insert into withdrawals(user_id, amount, charge, bank_name, account_number, account_name, status, method)
  values (u, 700, 105, 'Old Bank', '0123456789', 'WD Actions', 'approved', 'manual') returning id into adm;
  insert into ids values ('E', adm);
end $$;

-- ===== A signed-in user cannot call the admin functions, nor request without a bank code =====
select set_config('request.jwt.claims', json_build_object('sub', (select ids.id from ids where k='u'), 'role','authenticated')::text, true);
set local role authenticated;
do $$
begin
  begin perform admin_mark_withdrawal_paid((select ids.id from ids where k='A'), null); insert into r(step,val) values ('user calls admin_mark_withdrawal_paid', 'ALLOWED (bad)');
  exception when others then insert into r(step,val) values ('user calls admin_mark_withdrawal_paid', 'denied'); end;
  begin perform admin_reject_withdrawal((select ids.id from ids where k='B'), null); insert into r(step,val) values ('user calls admin_reject_withdrawal', 'ALLOWED (bad)');
  exception when others then insert into r(step,val) values ('user calls admin_reject_withdrawal', 'denied'); end;
  begin perform user_request_withdrawal(1000, 'Some Bank', null, '0123456789', 'WD Actions'); insert into r(step,val) values ('withdraw without bank_code', 'ALLOWED (bad)');
  exception when others then insert into r(step,val) values ('withdraw without bank_code', 'refused: '||sqlerrm); end;
  begin perform user_request_withdrawal(1000, 'Some Bank', 'OTHER', '0123456789', 'WD Actions'); insert into r(step,val) values ('withdraw with free-text bank', 'ALLOWED (bad)');
  exception when others then insert into r(step,val) values ('withdraw with free-text bank', 'refused: '||sqlerrm); end;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ===== As the admin API (service role) =====
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare u uuid := (select ids.id from ids where k='u'); adm uuid := (select ids.id from ids where k='adm');
begin
  -- Mark as paid
  insert into r(step,val) values ('mark paid A', admin_mark_withdrawal_paid((select ids.id from ids where k='A'), adm)->>'result');
  insert into r(step,val) values ('A row', (select status||'/'||method||'/'||(processed_at is not null)::text||'/'||(processed_by is not distinct from adm)::text from withdrawals where id = (select ids.id from ids where k='A')));
  insert into r(step,val) values ('wallet unchanged by mark paid (exp 1000.00)', (select available_balance::text from wallets where user_id = u));
  insert into r(step,val) values ('paid notification (net 1,700.00)', (select message from notifications where user_id = u and title = 'Withdrawal Paid'));
  insert into r(step,val) values ('mark paid A again', admin_mark_withdrawal_paid((select ids.id from ids where k='A'), adm)::text);
  insert into r(step,val) values ('mark paid processing C', admin_mark_withdrawal_paid((select ids.id from ids where k='C'), adm)::text);
  insert into r(step,val) values ('mark paid unknown id', admin_mark_withdrawal_paid(gen_random_uuid(), adm)->>'result');

  -- Reject & refund
  insert into r(step,val) values ('reject B (exp refunded 4000)', admin_reject_withdrawal((select ids.id from ids where k='B'), adm)::text);
  insert into r(step,val) values ('reject B again (no double refund)', admin_reject_withdrawal((select ids.id from ids where k='B'), adm)::text);
  insert into r(step,val) values ('wallet after reject B (exp 4000.00)', (select available_balance::text from wallets where user_id = u));
  insert into r(step,val) values ('refund ledger + notif', (select count(*)::text from transactions where user_id = u and type = 'withdrawal_refund')||'/'||(select count(*)::text from notifications where user_id = u and title = 'Withdrawal Rejected'));
  insert into r(step,val) values ('reject C (gateway acknowledged -> refused)', admin_reject_withdrawal((select ids.id from ids where k='C'), adm)::text);
  insert into r(step,val) values ('reject D (outcome unknown -> allowed, exp 9000)', admin_reject_withdrawal((select ids.id from ids where k='D'), adm)::text);
  insert into r(step,val) values ('reject E (approved -> refused)', admin_reject_withdrawal((select ids.id from ids where k='E'), adm)::text);
  -- After a reject, a late payout callback for D must not pay or refund again.
  insert into r(step,val) values ('late payout callback on rejected D', gateway_apply_payout('ALXW-WDT-D', 'osnD', 9, 4250, 'late', null, '{}'));
  insert into r(step,val) values ('wallet final (exp 9000.00)', (select available_balance::text from wallets where user_id = u));
  insert into r(step,val) values ('statuses A..E', (select string_agg(k||':'||w.status, ' ' order by k) from ids join withdrawals w on w.id = ids.id where k in ('A','B','C','D','E')));
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- Atomicity: both functions lock the rows they change and run as definer.
insert into r(step,val)
select p.proname, (p.prosecdef)::text||'/'||(position('for update' in p.prosrc) > 0)::text
       ||'/'||(select string_agg(distinct grantee::regrole::text, ',' order by grantee::regrole::text) from aclexplode(p.proacl) where privilege_type = 'EXECUTE')
  from pg_proc p where p.proname in ('admin_mark_withdrawal_paid','admin_reject_withdrawal') order by 1;
insert into r(step,val)
select 'reject locks wallet row', (position('from public.wallets where user_id = w.user_id for update' in prosrc) > 0)::text
  from pg_proc where proname = 'admin_reject_withdrawal';

do $$ begin raise exception 'RESULTS %', (select json_agg(json_build_object('step', step, 'val', val) order by n) from r); end $$;
rollback;
