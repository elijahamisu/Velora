begin;
create temp table r(step text, val text); grant all on r to authenticated;
do $$
declare u uuid := gen_random_uuid(); adm uuid; code text; res text; wid uuid;
begin
  select id, referral_code into adm, code from profiles where role='admin' limit 1;
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (u, '00000000-0000-0000-0000-000000000000','authenticated','authenticated','gwtest@example.invalid',
          jsonb_build_object('full_name','GW Test','referred_by',code), now(), now());
  update wallets set available_balance = 0 where user_id in (u, adm);
  insert into r values ('referred_by_admin', ((select referred_by from profiles where id=u) = adm)::text);
  update site_settings set referral_commission_pct = 20 where id=1;

  insert into deposits(user_id, amount, method, order_sn, status) values (u, 5000, 'gateway', 'ALXD-T1', 'pending');
  insert into r values ('payin full', gateway_apply_payin('ALXD-T1','osnA',1,5000,'Paid Success','UTR1','{}'));
  insert into r values ('payin dup', gateway_apply_payin('ALXD-T1','osnA',1,5000,'Paid Success','UTR1','{}'));
  insert into r values ('payin osn mismatch', gateway_apply_payin('ALXD-T1','osnZ',1,5000,null,null,'{}'));
  insert into deposits(user_id, amount, method, order_sn, status) values (u, 4000, 'gateway', 'ALXD-T2', 'pending');
  insert into r values ('payin partial', gateway_apply_payin('ALXD-T2','osnB',1,3000,null,null,'{}'));
  insert into deposits(user_id, amount, method, order_sn, status) values (u, 4000, 'gateway', 'ALXD-T3', 'pending');
  insert into r values ('payin status2', gateway_apply_payin('ALXD-T3','osnC',2,null,'Expired',null,'{}'));
  insert into r values ('payin status2 again', gateway_apply_payin('ALXD-T3','osnC',2,null,'Expired',null,'{}'));
  insert into r values ('payin late success overpaid', gateway_apply_payin('ALXD-T3','osnC',1,6000,null,null,'{}'));
  insert into r values ('payin unknown', gateway_apply_payin('ALXD-NOPE','x',1,1,null,null,'{}'));
  insert into r values ('deposits', (select string_agg(order_sn||':'||status||':'||coalesce(credited_amount::text,'-'), ' ' order by order_sn) from deposits where user_id=u));
  insert into r values ('user wallet after deposits (exp 5000+3000+4000=12000)', (select available_balance::text from wallets where user_id=u));
  insert into r values ('admin referral (exp 20% of 12000=2400)', (select available_balance::text from wallets where user_id=adm));
  insert into r values ('tx count user deposit', (select count(*)::text from transactions where user_id=u and type='deposit'));
  insert into r values ('manual approve on gateway dep blocked?', 'see below');

  insert into withdrawals(user_id, amount, charge, status, order_sn, payout_amount, method) values (u, 1000, 150, 'processing', 'ALXW-T1', 850, 'gateway');
  insert into r values ('payout amount mismatch', gateway_apply_payout('ALXW-T1','p1',1,800,null,null,'{}'));
  insert into r values ('payout success', gateway_apply_payout('ALXW-T1','p1',1,850,'ok','U2','{}'));
  insert into r values ('payout success dup', gateway_apply_payout('ALXW-T1','p1',1,850,'ok','U2','{}'));
  insert into r values ('payout 9 after success', gateway_apply_payout('ALXW-T1','p1',9,850,'x',null,'{}'));
  insert into withdrawals(user_id, amount, charge, status, order_sn, payout_amount, method) values (u, 2000, 300, 'processing', 'ALXW-T2', 1700, 'gateway');
  insert into r values ('payout failed', gateway_apply_payout('ALXW-T2','p2',9,1700,'Invalid account',null,'{}'));
  insert into r values ('payout failed dup', gateway_apply_payout('ALXW-T2','p2',9,1700,'Invalid account',null,'{}'));
  insert into r values ('user wallet after refund (exp 12000+2000=14000)', (select available_balance::text from wallets where user_id=u));
  insert into r values ('withdrawals', (select string_agg(order_sn||':'||status, ' ' order by order_sn) from withdrawals where user_id=u));

  insert into gateway_admin_transactions(kind, order_sn, amount, fee_pct, fee_amount, total_debit, status) values ('payout','ALXAP-T1',1000,11,110,1110,'processing');
  insert into r values ('admin payout mismatch', gateway_apply_admin('ALXAP-T1','payout','q1',1,999,null,null,null,'{}'));
  insert into r values ('admin payout ok', gateway_apply_admin('ALXAP-T1','payout','q1',1,1000,null,'ok',null,'{}'));
  insert into r values ('admin payout dup', gateway_apply_admin('ALXAP-T1','payout','q1',1,1000,null,'ok',null,'{}'));
  insert into gateway_admin_transactions(kind, order_sn, amount, status) values ('topup','ALXAT-T1',50000,'pending');
  insert into r values ('admin topup ok', gateway_apply_admin('ALXAT-T1','topup','q2',1,50000,50000,'ok',null,'{}'));
  insert into r values ('admin topup wrong kind', gateway_apply_admin('ALXAT-T1','payout','q2',1,50000,null,null,null,'{}'));
  insert into r values ('user wallet unchanged by admin ops', (select available_balance::text from wallets where user_id=u));

  insert into deposits(user_id, amount, method, order_sn, status) values (u, 4000, 'gateway', 'ALXD-T4', 'pending');
  -- act as the user
  perform set_config('request.jwt.claims', json_build_object('sub', u, 'role','authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    update withdrawals set amount = 999999 where order_sn='ALXW-T2';
    insert into r values ('user update withdrawal', 'ALLOWED (bad)');
  exception when others then insert into r values ('user update withdrawal', 'blocked: '||sqlerrm); end;
  begin
    delete from withdrawals where order_sn='ALXW-T1';
    insert into r values ('user delete sent withdrawal', 'rows='||(select count(*) from withdrawals where order_sn='ALXW-T1'));
  exception when others then insert into r values ('user delete sent withdrawal', 'blocked: '||sqlerrm); end;
  begin
    insert into deposits(user_id, amount, method, order_sn, status) values (u, 5000, 'gateway', 'ALXD-FORGED', 'approved') returning id into wid;
    insert into r values ('user forged deposit', (select method||':'||status||':'||coalesce(order_sn,'null') from deposits where id=wid));
  exception when others then insert into r values ('user forged deposit', 'error: '||sqlerrm); end;
  begin
    perform gateway_apply_payin('ALXD-T1','osnA',1,5000,null,null,'{}');
    insert into r values ('user calls gateway_apply_payin', 'ALLOWED (bad)');
  exception when others then insert into r values ('user calls gateway_apply_payin', 'blocked: '||sqlerrm); end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role','authenticated')::text, true);
  begin
    perform admin_approve_deposit((select id from deposits where order_sn='ALXD-T4'));
    insert into r values ('admin manual approve gateway deposit', 'ALLOWED (bad)');
  exception when others then insert into r values ('admin manual approve gateway deposit', 'blocked: '||sqlerrm); end;
end $$;
select * from r;
rollback;
