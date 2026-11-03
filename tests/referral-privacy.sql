-- Referral privacy check. Run after supabase/schema.sql. Raises TESTRESULT with the observed values
-- (the exception rolls everything back). Expect: A sees B profile rows=0, B phone=NULL, masked my_referrals,
-- admin_notes col gone, B own notes rows=0, anon rpc denied, admin full access.
do $t$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  r text := ''; n int; v text; rec record;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (a,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ref_a@test.local','{"full_name":"Alice Referrer"}',now(),now()),
         (b,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ref_b@test.local','{"full_name":"Bob Middle Smith"}',now(),now()),
         (c,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','ref_c@test.local','{"full_name":"Carol Down"}',now(),now()),
         (adm,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','adm@test.local','{"full_name":"Ad Min"}',now(),now());
  -- ensure profiles exist
  insert into public.profiles (id, full_name, email) values (a,'Alice Referrer','ref_a@test.local'),(b,'Bob Middle Smith','ref_b@test.local'),(c,'Carol Down','ref_c@test.local'),(adm,'Ad Min','adm@test.local') on conflict (id) do nothing;
  update public.profiles set full_name='Bob Middle Smith', phone='0800000000', referred_by=a, status_reason='x' where id=b;
  update public.profiles set referred_by=b where id=c;
  update public.profiles set role='admin' where id=adm;
  insert into public.profile_admin_notes(user_id, notes) values (b,'secret note');
  insert into public.transactions(user_id, amount, type, reference, description) values (a, 50, 'referral_bonus', 'referral:'||b, 't');

  -- as referrer A
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.profiles where id=b; r := r || 'A sees B profile rows=' || n;
  select count(*) into n from public.profiles where id=a; r := r || '; A sees own=' || n;
  select phone into v from public.profiles where id=b; r := r || '; A reads B phone=' || coalesce(v,'NULL');
  select count(*) into n from public.profile_admin_notes; r := r || '; A notes rows=' || n;
  select count(*) into n from public.investments where user_id=b; r := r || '; A sees B investments=' || n;
  for rec in select * from public.my_referrals() loop r := r || '; my_referrals: ' || row_to_json(rec)::text; end loop;
  select row_to_json(x)::text into v from public.my_referral_tiers() x; r := r || '; tiers=' || v;
  begin perform 1 from public.profiles where admin_notes is not null; r := r || '; admin_notes col EXISTS';
  exception when undefined_column then r := r || '; admin_notes col gone'; end;
  -- own row update still works, protect_role blocks role change
  update public.profiles set full_name='Alice R', role='admin' where id=a;
  select full_name||'/'||role into v from public.profiles where id=a; r := r || '; A self-update=' || v;
  execute 'reset role';

  -- as B (own row incl status_reason)
  perform set_config('request.jwt.claims', json_build_object('sub',b,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select email||'/'||coalesce(status_reason,'') into v from public.profiles where id=b; r := r || '; B own=' || v;
  select count(*) into n from public.profile_admin_notes where user_id=b; r := r || '; B own notes rows=' || n;
  select count(*) into n from public.profiles where id=a; r := r || '; B sees referrer A=' || n;
  execute 'reset role';

  -- anon
  execute 'set local role anon';
  begin perform public.my_referrals(); r := r || '; anon rpc ALLOWED'; exception when insufficient_privilege then r := r || '; anon rpc denied'; end;
  execute 'reset role';

  -- admin
  perform set_config('request.jwt.claims', json_build_object('sub',adm,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select email||'/'||phone into v from public.profiles where id=b; r := r || '; admin reads B=' || v;
  select count(*) into n from public.profiles; r := r || '; admin profiles count=' || n;
  select notes into v from public.profile_admin_notes where user_id=b; r := r || '; admin note=' || coalesce(v,'NULL');
  insert into public.profile_admin_notes(user_id, notes) values (c,'n2') on conflict (user_id) do update set notes=excluded.notes;
  update public.profiles set phone='0811' where id=b; select phone into v from public.profiles where id=b; r := r || '; admin update B phone=' || v;
  execute 'reset role';
  raise exception 'TESTRESULT: %', r;
end $t$;
