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

-- ============================================================
-- 2026-11-02 · Admin user details + Admin site settings
-- ============================================================

-- ---------- Account status on profiles ----------
alter table public.profiles add column if not exists status text not null default 'active';
alter table public.profiles add column if not exists status_reason text;
alter table public.profiles add column if not exists status_changed_at timestamptz;
alter table public.profiles add column if not exists admin_notes text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_status_check') then
    alter table public.profiles add constraint profiles_status_check
      check (status in ('active','suspended','banned'));
  end if;
end $$;

-- Non-admins can never change their own role, status or admin notes.
-- Admins (is_admin()) and server/service-role calls (auth.uid() is null) can.
create or replace function public.protect_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.role := old.role;
    new.status := old.status;
    new.status_reason := old.status_reason;
    new.status_changed_at := old.status_changed_at;
    new.admin_notes := old.admin_notes;
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  new.updated_at := now();
  return new;
end; $$;
drop trigger if exists protect_role on public.profiles;
create trigger protect_role before update on public.profiles for each row execute function public.protect_role();

-- True when the caller is an active (not suspended/banned) user, or an admin.
create or replace function public.is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'active' or role in ('admin','super_admin')
                     from public.profiles where id = auth.uid()), false);
$$;

-- Suspended/banned users cannot create money-moving rows or touch their wallet,
-- even with a still-valid token. Restrictive policies AND with the existing ones.
do $$ declare t text;
begin
  foreach t in array array['deposits','withdrawals','investments','transactions','gift_redemptions','tickets','ticket_messages']
  loop
    execute format('drop policy if exists active_only_ins on public.%I', t);
    execute format('create policy active_only_ins on public.%I as restrictive for insert with check (public.is_active_user())', t);
  end loop;
end $$;
drop policy if exists active_only_upd on public.wallets;
create policy active_only_upd on public.wallets as restrictive for update using (public.is_active_user()) with check (public.is_active_user());
drop policy if exists active_only_upd on public.gift_codes;
create policy active_only_upd on public.gift_codes as restrictive for update using (public.is_active_user()) with check (public.is_active_user());

-- ---------- Site settings (single row, id = 1) ----------
create table if not exists public.site_settings (
  id int primary key default 1 check (id = 1),
  site_name text not null default 'Altivex',
  tagline text not null default 'Put your money to work, daily.',
  support_email text not null default '',
  support_phone text not null default '',
  support_whatsapp text not null default '',
  telegram_link text not null default 'https://t.me/+s66HnQZjuCFhZTI0',
  telegram_support_link text not null default 'https://t.me/+s66HnQZjuCFhZTI0',
  bank_name text not null default 'FIDELITY BANK',
  bank_account_name text not null default 'AMISU ELIJAH',
  bank_account_number text not null default '4580003805',
  min_deposit numeric(14,2) not null default 3000,
  max_deposit numeric(14,2),               -- null = no limit
  min_withdrawal numeric(14,2) not null default 600,
  max_withdrawal numeric(14,2),            -- null = no limit
  withdrawal_fee_pct numeric(6,2) not null default 15,
  withdrawal_days int[] not null default '{0,1,2,3,4,5,6}',  -- 0 = Sunday … 6 = Saturday (Africa/Lagos)
  withdrawal_open_time time not null default '00:00',
  withdrawal_close_time time not null default '23:59',
  welcome_bonus numeric(14,2) not null default 600,
  referral_commission_pct numeric(6,2) not null default 20,
  maintenance_mode boolean not null default false,
  maintenance_message text not null default 'We are carrying out scheduled maintenance. Please check back shortly.',
  registration_open boolean not null default true,
  announcement_text text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.site_settings (id) values (1) on conflict (id) do nothing;

alter table public.site_settings enable row level security;
drop policy if exists public_read on public.site_settings;
create policy public_read on public.site_settings for select using (true);
drop policy if exists admin_all on public.site_settings;
create policy admin_all on public.site_settings for all using (public.is_admin()) with check (public.is_admin());
grant select on public.site_settings to anon, authenticated;
grant insert, update on public.site_settings to authenticated;

create or replace function public.touch_site_settings() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.id := 1;
  return new;
end; $$;
drop trigger if exists touch_site_settings on public.site_settings;
create trigger touch_site_settings before update on public.site_settings
  for each row execute function public.touch_site_settings();

-- ---------- Welcome bonus from settings ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ref_code text := nullif(trim(new.raw_user_meta_data->>'referred_by'), '');
  ref_id uuid;
  bonus numeric := coalesce((select welcome_bonus from public.site_settings where id = 1), 0);
  sname text := coalesce((select site_name from public.site_settings where id = 1), 'Altivex');
begin
  if coalesce((select registration_open from public.site_settings where id = 1), true) = false then
    raise exception 'Registration is currently closed';
  end if;
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

  insert into public.wallets (user_id, available_balance, bonus_balance)
  values (new.id, greatest(bonus, 0), greatest(bonus, 0));
  insert into public.earnings (user_id) values (new.id);
  insert into public.transactions (user_id, amount, type, description)
  values (new.id, greatest(bonus, 0), 'welcome',
          case when bonus > 0 then 'Welcome bonus · ' || sname else 'Welcome to ' || sname end);
  return new;
end; $$;

-- ---------- Admin RPCs (security definer, admin-checked) ----------
-- Set every wallet column at once; logs one transaction per changed column.
create or replace function public.admin_set_wallet(
  p_user uuid,
  p_available numeric, p_investment numeric, p_bonus numeric, p_referral numeric, p_total_earnings numeric,
  p_today_earnings numeric, p_earnings_total numeric,
  p_reason text
) returns void
language plpgsql security definer set search_path = public as $$
declare w public.wallets; e public.earnings; why text := coalesce(nullif(trim(p_reason),''), 'Admin adjustment');
begin
  if not public.is_admin() then raise exception 'Admin privileges required'; end if;
  select * into w from public.wallets where user_id = p_user for update;
  if not found then
    insert into public.wallets (user_id) values (p_user) returning * into w;
  end if;
  select * into e from public.earnings where user_id = p_user for update;
  if not found then
    insert into public.earnings (user_id) values (p_user) returning * into e;
  end if;

  if p_available is not null and p_available is distinct from w.available_balance then
    insert into public.transactions (user_id, amount, type, description)
    values (p_user, abs(p_available - w.available_balance),
            case when p_available > w.available_balance then 'admin_credit' else 'admin_debit' end,
            'Available balance ' || to_char(w.available_balance,'FM999999999990.00') || ' → ' || to_char(p_available,'FM999999999990.00') || ' · ' || why);
  end if;
  if p_investment is not null and p_investment is distinct from w.investment_balance then
    insert into public.transactions (user_id, amount, type, description)
    values (p_user, abs(p_investment - w.investment_balance), 'admin_adjustment',
            'Investment balance ' || to_char(w.investment_balance,'FM999999999990.00') || ' → ' || to_char(p_investment,'FM999999999990.00') || ' · ' || why);
  end if;
  if p_bonus is not null and p_bonus is distinct from w.bonus_balance then
    insert into public.transactions (user_id, amount, type, description)
    values (p_user, abs(p_bonus - w.bonus_balance), 'admin_adjustment',
            'Bonus balance ' || to_char(w.bonus_balance,'FM999999999990.00') || ' → ' || to_char(p_bonus,'FM999999999990.00') || ' · ' || why);
  end if;
  if p_referral is not null and p_referral is distinct from w.referral_balance then
    insert into public.transactions (user_id, amount, type, description)
    values (p_user, abs(p_referral - w.referral_balance), 'admin_adjustment',
            'Referral balance ' || to_char(w.referral_balance,'FM999999999990.00') || ' → ' || to_char(p_referral,'FM999999999990.00') || ' · ' || why);
  end if;
  if p_total_earnings is not null and p_total_earnings is distinct from w.total_earnings then
    insert into public.transactions (user_id, amount, type, description)
    values (p_user, abs(p_total_earnings - w.total_earnings), 'admin_adjustment',
            'Total earnings ' || to_char(w.total_earnings,'FM999999999990.00') || ' → ' || to_char(p_total_earnings,'FM999999999990.00') || ' · ' || why);
  end if;

  update public.wallets set
    available_balance  = coalesce(p_available, available_balance),
    investment_balance = coalesce(p_investment, investment_balance),
    bonus_balance      = coalesce(p_bonus, bonus_balance),
    referral_balance   = coalesce(p_referral, referral_balance),
    total_earnings     = coalesce(p_total_earnings, total_earnings),
    updated_at = now()
  where user_id = p_user;

  update public.earnings set
    today_earnings = coalesce(p_today_earnings, today_earnings),
    total_earnings = coalesce(p_earnings_total, total_earnings),
    updated_at = now()
  where user_id = p_user;
end; $$;

-- Approve a pending deposit: credit wallet, pay referrer commission (site setting), notify.
create or replace function public.admin_approve_deposit(p_deposit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deposits; ref uuid; pct numeric; bonus numeric;
begin
  if not public.is_admin() then raise exception 'Admin privileges required'; end if;
  update public.deposits set status = 'approved' where id = p_deposit and status = 'pending' returning * into d;
  if not found then raise exception 'Deposit not found or already processed'; end if;

  update public.wallets set available_balance = available_balance + d.amount, updated_at = now() where user_id = d.user_id;

  select referred_by into ref from public.profiles where id = d.user_id;
  if ref is not null then
    pct := coalesce((select referral_commission_pct from public.site_settings where id = 1), 20);
    bonus := round(d.amount * pct / 100, 2);
    if bonus > 0 then
      update public.wallets set available_balance = available_balance + bonus, updated_at = now() where user_id = ref;
      insert into public.transactions (user_id, amount, type, description)
      values (ref, bonus, 'referral_bonus',
              trim(to_char(pct,'FM990.##')) || '% referral bonus from a downstream deposit of ₦' || to_char(d.amount,'FM999,999,999,990'));
    end if;
  end if;

  insert into public.notifications (user_id, title, message)
  values (d.user_id, 'Deposit Approved',
          'Your deposit of ₦' || to_char(d.amount,'FM999,999,999,990') || ' has been approved and credited to your wallet.');
end; $$;

create or replace function public.admin_reject_deposit(p_deposit uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Admin privileges required'; end if;
  update public.deposits set status = 'rejected' where id = p_deposit and status = 'pending';
  if not found then raise exception 'Deposit not found or already processed'; end if;
end; $$;

revoke execute on function public.admin_set_wallet(uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text) from public, anon;
revoke execute on function public.admin_approve_deposit(uuid) from public, anon;
revoke execute on function public.admin_reject_deposit(uuid) from public, anon;
grant execute on function public.admin_set_wallet(uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text) to authenticated;
grant execute on function public.admin_approve_deposit(uuid) to authenticated;
grant execute on function public.admin_reject_deposit(uuid) to authenticated;

-- ---------- Server-side enforcement of deposit/withdrawal settings ----------
-- Applies to signed-in non-admin users; admins and service-role calls are exempt.
create or replace function public.enforce_deposit_limits() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.site_settings;
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  select * into s from public.site_settings where id = 1;
  if not found then return new; end if;
  if new.amount < s.min_deposit then
    raise exception 'Minimum deposit is ₦%', to_char(s.min_deposit,'FM999,999,999,990');
  end if;
  if s.max_deposit is not null and s.max_deposit > 0 and new.amount > s.max_deposit then
    raise exception 'Maximum deposit is ₦%', to_char(s.max_deposit,'FM999,999,999,990');
  end if;
  return new;
end; $$;
drop trigger if exists enforce_deposit_limits on public.deposits;
create trigger enforce_deposit_limits before insert on public.deposits
  for each row execute function public.enforce_deposit_limits();

create or replace function public.enforce_withdrawal_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.site_settings; lagos timestamp := now() at time zone 'Africa/Lagos'; t time;
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  select * into s from public.site_settings where id = 1;
  if not found then return new; end if;
  if new.amount < s.min_withdrawal then
    raise exception 'Minimum withdrawal is ₦%', to_char(s.min_withdrawal,'FM999,999,999,990');
  end if;
  if s.max_withdrawal is not null and s.max_withdrawal > 0 and new.amount > s.max_withdrawal then
    raise exception 'Maximum withdrawal is ₦%', to_char(s.max_withdrawal,'FM999,999,999,990');
  end if;
  t := lagos::time;
  if not (extract(dow from lagos)::int = any(s.withdrawal_days)) or
     (case when s.withdrawal_open_time <= s.withdrawal_close_time
           then t < s.withdrawal_open_time or t > s.withdrawal_close_time + interval '59 seconds'
           else t < s.withdrawal_open_time and t > s.withdrawal_close_time + interval '59 seconds' end) then
    raise exception 'Withdrawals are closed right now';
  end if;
  new.charge := round(new.amount * s.withdrawal_fee_pct / 100, 2);
  new.status := 'pending';
  return new;
end; $$;
drop trigger if exists enforce_withdrawal_rules on public.withdrawals;
create trigger enforce_withdrawal_rules before insert on public.withdrawals
  for each row execute function public.enforce_withdrawal_rules();
