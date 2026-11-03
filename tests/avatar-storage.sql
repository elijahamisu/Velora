-- Profile photo + storage policy check. Run after supabase/schema.sql. Raises TESTRESULT with the
-- observed values (the exception rolls everything back, so no users/objects are left behind).
-- Expect: own-folder insert ok, other/ root folder denied, cross-user select/update/delete = 0 rows,
-- own update/delete = 1, anon insert denied, admin sees all, avatar_url only accepted for own folder.
do $t$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); adm uuid := gen_random_uuid();
  r text := ''; n int; v text;
  base text := 'https://bqycpupnmjkqqnzujotp.supabase.co/storage/v1/object/public/avatars/';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  values (a,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','av_a@test.local','{"full_name":"Ava A"}',now(),now()),
         (b,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','av_b@test.local','{"full_name":"Ben B"}',now(),now()),
         (adm,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','av_adm@test.local','{"full_name":"Ad Min"}',now(),now());
  insert into public.profiles (id, full_name, email) values (a,'Ava A','av_a@test.local'),(b,'Ben B','av_b@test.local'),(adm,'Ad Min','av_adm@test.local') on conflict (id) do nothing;
  update public.profiles set role='admin' where id=adm;

  -- B uploads first
  perform set_config('request.jwt.claims', json_build_object('sub',b,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  insert into storage.objects (bucket_id, name, owner) values ('avatars', b||'/avatar-1.webp', b);
  r := r || 'B own insert ok';
  execute 'reset role';

  -- as A
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  begin insert into storage.objects (bucket_id, name, owner) values ('avatars', a||'/avatar-1.webp', a); r := r || '; A own insert ok';
  exception when others then r := r || '; A own insert DENIED ' || sqlerrm; end;
  begin insert into storage.objects (bucket_id, name, owner) values ('avatars', b||'/evil.webp', a); r := r || '; A into B folder ALLOWED';
  exception when insufficient_privilege then r := r || '; A into B folder denied'; end;
  begin insert into storage.objects (bucket_id, name, owner) values ('avatars', 'root.webp', a); r := r || '; A root ALLOWED';
  exception when insufficient_privilege then r := r || '; A root denied'; end;
  begin insert into storage.objects (bucket_id, name, owner) values ('avatars', 'avatars/'||a||'-x.webp', a); r := r || '; A legacy path ALLOWED';
  exception when insufficient_privilege then r := r || '; A legacy path denied'; end;
  begin insert into storage.objects (bucket_id, name, owner) values ('support-screenshots', a||'/1_s.png', a); r := r || '; A own screenshot ok';
  exception when others then r := r || '; A own screenshot DENIED ' || sqlerrm; end;
  begin insert into storage.objects (bucket_id, name, owner) values ('support-screenshots', 'support/1_s.png', a); r := r || '; A support/ ALLOWED';
  exception when insufficient_privilege then r := r || '; A support/ denied'; end;
  select count(*) into n from storage.objects where bucket_id='avatars' and name like b||'/%'; r := r || '; A sees B objects=' || n;
  select count(*) into n from storage.objects where bucket_id='avatars' and name like a||'/%'; r := r || '; A sees own=' || n;
  update storage.objects set metadata = '{"x":1}' where bucket_id='avatars' and name = b||'/avatar-1.webp'; get diagnostics n = row_count; r := r || '; A update B=' || n;
  update storage.objects set metadata = '{"x":1}' where bucket_id='avatars' and name = a||'/avatar-1.webp'; get diagnostics n = row_count; r := r || '; A update own=' || n;
  begin
    perform set_config('storage.allow_delete_query', 'true', true);
    delete from storage.objects where bucket_id='avatars' and name = b||'/avatar-1.webp'; get diagnostics n = row_count; r := r || '; A delete B=' || n;
    delete from storage.objects where bucket_id='avatars' and name = a||'/avatar-1.webp'; get diagnostics n = row_count; r := r || '; A delete own=' || n;
  exception when others then r := r || '; delete test skipped: ' || sqlerrm; end;

  -- avatar_url guard (protect_role)
  begin update public.profiles set avatar_url = 'https://evil.example/x.png' where id=a; r := r || '; external url ACCEPTED';
  exception when others then r := r || '; external url rejected'; end;
  begin update public.profiles set avatar_url = base || b || '/avatar-1.webp' where id=a; r := r || '; B url ACCEPTED';
  exception when others then r := r || '; B url rejected'; end;
  begin update public.profiles set avatar_url = base || a || '/avatar-1.webp" onerror="x' where id=a; r := r || '; quote url ACCEPTED';
  exception when others then r := r || '; quote url rejected'; end;
  update public.profiles set avatar_url = base || a || '/avatar-123.webp' where id=a;
  select avatar_url into v from public.profiles where id=a; r := r || '; own url saved=' || (v = base || a || '/avatar-123.webp');
  update public.profiles set full_name = 'Ava Renamed' where id=a; r := r || '; unrelated update ok';
  update public.profiles set avatar_url = null where id=a;
  select coalesce(avatar_url,'NULL') into v from public.profiles where id=a; r := r || '; remove=' || v;
  execute 'reset role';

  -- anon
  execute 'set local role anon';
  begin insert into storage.objects (bucket_id, name) values ('avatars', a||'/anon.webp'); r := r || '; anon insert ALLOWED';
  exception when insufficient_privilege then r := r || '; anon insert denied'; end;
  select count(*) into n from storage.objects where bucket_id='avatars'; r := r || '; anon list=' || n;
  execute 'reset role';

  -- admin
  perform set_config('request.jwt.claims', json_build_object('sub',adm,'role','authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from storage.objects where bucket_id='avatars' and name like b||'/%'; r := r || '; admin sees B=' || n;
  update public.profiles set avatar_url = 'https://cdn.example/a.png' where id=b; r := r || '; admin may set any url';
  execute 'reset role';

  select string_agg(id||':'||coalesce(file_size_limit::text,'none')||':'||array_to_string(allowed_mime_types,'|'), ' ') into v from storage.buckets where id in ('avatars','support-screenshots');
  r := r || '; buckets=' || v;

  raise exception 'TESTRESULT: %', r;
end $t$;
