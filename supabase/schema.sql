-- Altivex database schema (inferred from the app's queries)
create extension if not exists pgcrypto;

-- ============ TABLES ============
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text,
  phone text,
  role text not null default 'user' check (role in ('user','admin','super_admin')),
  referral_code text unique,
  referred_by uuid references public.profiles(id) on delete set null,
  avatar_url text,
  terms_accepted boolean not null default false,
  terms_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  available_balance numeric(14,2) not null default 0,
  investment_balance numeric(14,2) not null default 0,
  bonus_balance numeric(14,2) not null default 0,
  referral_balance numeric(14,2) not null default 0,
  total_earnings numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.earnings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.profiles(id) on delete cascade,
  today_earnings numeric(14,2) not null default 0,
  total_earnings numeric(14,2) not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.investment_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text default 'starter',
  price numeric(14,2) not null,
  daily_roi_pct numeric(6,2) not null,
  duration_days int not null,
  sort_order int not null default 0,
  is_popular boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.investments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  plan_id uuid references public.investment_plans(id) on delete set null,
  amount_invested numeric(14,2) not null,
  daily_earning_amount numeric(14,2) not null default 0,
  remaining_days int not null default 0,
  status text not null default 'active',
  last_paid_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(14,2) not null default 0,
  type text not null,
  description text,
  reference text default ('TX-' || upper(substr(md5(random()::text),1,10))),
  created_at timestamptz not null default now()
);

create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(14,2) not null,
  account_name text,
  bank_name text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(14,2) not null,
  charge numeric(14,2) not null default 0,
  bank_name text,
  account_number text,
  account_name text,
  status text not null default 'pending',
  processed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  title text,
  message text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.gift_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  amount numeric(14,2) not null,
  usage_limit int,
  current_usage int not null default 0,
  expiry_date timestamptz,
  is_active boolean not null default true,
  is_used boolean not null default false,
  used_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.gift_redemptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  gift_code_id uuid not null references public.gift_codes(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, gift_code_id)
);

create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  subject text,
  category text,
  screenshot_url text,
  status text not null default 'Open',
  created_at timestamptz not null default now()
);

create table if not exists public.ticket_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.tickets(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  message text not null,
  created_at timestamptz not null default now()
);

-- ============ HELPERS ============
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role in ('admin','super_admin'));
$$;

create or replace function public.increment_balance(row_id uuid, amt numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.wallets set bonus_balance = bonus_balance + amt,
                            available_balance = available_balance + amt,
                            updated_at = now()
   where user_id = row_id;
end; $$;

-- New signup -> profile, wallet, earnings, welcome transaction
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ref_code text := nullif(trim(new.raw_user_meta_data->>'referred_by'), '');
  ref_id uuid;
begin
  if ref_code is not null then
    select id into ref_id from public.profiles where upper(referral_code) = upper(ref_code) limit 1;
  end if;

  insert into public.profiles (id, full_name, email, phone, referral_code, referred_by)
  values (new.id,
          new.raw_user_meta_data->>'full_name',
          new.email,
          new.raw_user_meta_data->>'phone',
          'ALX-' || upper(substr(replace(new.id::text,'-',''),1,6)),
          ref_id);

  insert into public.wallets (user_id) values (new.id);
  insert into public.earnings (user_id) values (new.id);
  insert into public.transactions (user_id, amount, type, description)
  values (new.id, 0, 'welcome', 'Welcome to Altivex');
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Daily ROI payout for active investments
create or replace function public.process_daily_earnings() returns void
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  update public.earnings set today_earnings = 0, updated_at = now();
  for r in select * from public.investments
            where status = 'active' and remaining_days > 0
              and (last_paid_at is null or last_paid_at < now() - interval '23 hours')
  loop
    update public.wallets set available_balance = available_balance + r.daily_earning_amount,
                              total_earnings = total_earnings + r.daily_earning_amount,
                              updated_at = now()
     where user_id = r.user_id;
    update public.earnings set today_earnings = today_earnings + r.daily_earning_amount,
                               total_earnings = total_earnings + r.daily_earning_amount,
                               updated_at = now()
     where user_id = r.user_id;
    insert into public.transactions (user_id, amount, type, description)
    values (r.user_id, r.daily_earning_amount, 'daily_earning', 'Daily investment earning');
    update public.investments
       set remaining_days = remaining_days - 1,
           last_paid_at = now(),
           status = case when remaining_days - 1 <= 0 then 'completed' else status end
     where id = r.id;
  end loop;
end; $$;

-- ============ RLS ============
do $$ declare t text;
begin
  foreach t in array array['profiles','wallets','earnings','investment_plans','investments','transactions',
                           'deposits','withdrawals','notifications','gift_codes','gift_redemptions','tickets','ticket_messages']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('create policy admin_all on public.%I for all using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- profiles
create policy own_select on public.profiles for select using (id = auth.uid() or referred_by = auth.uid());
create policy own_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());
create or replace function public.protect_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role and not public.is_admin() and auth.uid() is not null then
    new.role := old.role;
  end if;
  return new;
end; $$;
drop trigger if exists protect_role on public.profiles;
create trigger protect_role before update on public.profiles for each row execute function public.protect_role();
-- per-user tables
create policy own_all on public.wallets for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_select on public.earnings for select using (user_id = auth.uid());
create policy own_all on public.investments for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy referral_active on public.investments for select using (
  user_id in (select id from public.profiles where referred_by = auth.uid()));
create policy own_rw on public.transactions for select using (user_id = auth.uid());
create policy own_ins on public.transactions for insert with check (user_id = auth.uid());
create policy own_rw on public.deposits for select using (user_id = auth.uid());
create policy own_ins on public.deposits for insert with check (user_id = auth.uid());
create policy own_all on public.withdrawals for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_all on public.notifications for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_all on public.gift_redemptions for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_all on public.tickets for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_select on public.ticket_messages for select using (
  ticket_id in (select id from public.tickets where user_id = auth.uid()));
create policy own_ins on public.ticket_messages for insert with check (
  user_id = auth.uid() and ticket_id in (select id from public.tickets where user_id = auth.uid()));
-- plans & gift codes readable by signed-in users
create policy read_plans on public.investment_plans for select using (true);
create policy read_codes on public.gift_codes for select using (auth.uid() is not null);
create policy use_codes on public.gift_codes for update using (auth.uid() is not null) with check (auth.uid() is not null);

-- ============ STORAGE ============
insert into storage.buckets (id, name, public) values ('avatars','avatars', true) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('support-screenshots','support-screenshots', true) on conflict (id) do nothing;
drop policy if exists "auth upload altivex" on storage.objects;
create policy "auth upload altivex" on storage.objects for insert to authenticated
  with check (bucket_id in ('avatars','support-screenshots'));
drop policy if exists "auth update altivex" on storage.objects;
create policy "auth update altivex" on storage.objects for update to authenticated
  using (bucket_id in ('avatars','support-screenshots') and owner = auth.uid());
drop policy if exists "public read altivex" on storage.objects;
create policy "public read altivex" on storage.objects for select
  using (bucket_id in ('avatars','support-screenshots'));

-- ============ DAILY CRON ============
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'altivex-daily-earnings';
select cron.schedule('altivex-daily-earnings', '0 0 * * *', 'select public.process_daily_earnings()');
