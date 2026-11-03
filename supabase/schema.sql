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

-- ============================================================
-- 2026-11-03 · Afrstar payment gateway (automatic deposits & payouts)
-- ============================================================

-- ---------- Payment mode switch (admin Settings) ----------
alter table public.site_settings add column if not exists payment_mode text not null default 'manual';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'site_settings_payment_mode_check') then
    alter table public.site_settings add constraint site_settings_payment_mode_check
      check (payment_mode in ('manual','gateway'));
  end if;
end $$;

-- ---------- Deposits: gateway fields ----------
alter table public.deposits add column if not exists method text not null default 'manual';
alter table public.deposits add column if not exists order_sn text;
alter table public.deposits add column if not exists platform_osn text;
alter table public.deposits add column if not exists pay_url text;
alter table public.deposits add column if not exists amount_paid numeric(14,2);
alter table public.deposits add column if not exists credited_amount numeric(14,2);
alter table public.deposits add column if not exists gateway_status int;
alter table public.deposits add column if not exists gateway_message text;
alter table public.deposits add column if not exists utr text;
alter table public.deposits add column if not exists callback_payload jsonb;
alter table public.deposits add column if not exists processed_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'deposits_method_check') then
    alter table public.deposits add constraint deposits_method_check check (method in ('manual','gateway'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'deposits_order_sn_key') then
    alter table public.deposits add constraint deposits_order_sn_key unique (order_sn);
  end if;
end $$;

-- ---------- Withdrawals: gateway fields ----------
-- status: pending -> (manual) approved | rejected
--         pending -> (gateway) processing -> approved (paid) | failed (refunded)
alter table public.withdrawals add column if not exists bank_code text;
alter table public.withdrawals add column if not exists method text not null default 'manual';
alter table public.withdrawals add column if not exists order_sn text;
alter table public.withdrawals add column if not exists platform_osn text;
alter table public.withdrawals add column if not exists payout_amount numeric(14,2);
alter table public.withdrawals add column if not exists gateway_status int;
alter table public.withdrawals add column if not exists gateway_message text;
alter table public.withdrawals add column if not exists utr text;
alter table public.withdrawals add column if not exists callback_payload jsonb;
alter table public.withdrawals add column if not exists sent_at timestamptz;
alter table public.withdrawals add column if not exists sent_by uuid references public.profiles(id) on delete set null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'withdrawals_method_check') then
    alter table public.withdrawals add constraint withdrawals_method_check check (method in ('manual','gateway'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'withdrawals_order_sn_key') then
    alter table public.withdrawals add constraint withdrawals_order_sn_key unique (order_sn);
  end if;
end $$;

-- ---------- Admin gateway funding / withdrawals ----------
create table if not exists public.gateway_admin_transactions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('payout','topup')),
  order_sn text not null unique,
  platform_osn text,
  amount numeric(14,2) not null,            -- payout: amount the bank account receives; topup: order amount
  fee_pct numeric(6,2) not null default 0,  -- payout: 11
  fee_amount numeric(14,2) not null default 0,
  total_debit numeric(14,2) not null default 0, -- payout: amount + fee (checked against gateway balance)
  balance_before numeric(14,2),
  bank_code text,
  bank_name text,
  account_number text,
  account_name text,
  pay_url text,
  amount_paid numeric(14,2),
  status text not null default 'processing' check (status in ('pending','processing','completed','failed')),
  gateway_status int,
  gateway_message text,
  utr text,
  callback_payload jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gateway_admin_transactions enable row level security;
drop policy if exists admin_all on public.gateway_admin_transactions;
create policy admin_all on public.gateway_admin_transactions for all using (public.is_admin()) with check (public.is_admin());

-- ---------- Harden user-side inserts/updates ----------
-- Users still insert manual deposits from the browser; they can never forge
-- gateway fields (gateway deposits are created by the server with the service key).
create or replace function public.enforce_deposit_limits() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.site_settings;
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  new.method := 'manual';
  new.status := 'pending';
  new.order_sn := null; new.platform_osn := null; new.pay_url := null;
  new.amount_paid := null; new.credited_amount := null; new.gateway_status := null;
  new.gateway_message := null; new.utr := null; new.callback_payload := null; new.processed_at := null;
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

create or replace function public.enforce_withdrawal_rules() returns trigger
language plpgsql security definer set search_path = public as $$
declare s public.site_settings; lagos timestamp := now() at time zone 'Africa/Lagos'; t time;
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  new.method := 'manual';
  new.order_sn := null; new.platform_osn := null; new.payout_amount := null;
  new.gateway_status := null; new.gateway_message := null; new.utr := null;
  new.callback_payload := null; new.sent_at := null; new.sent_by := null; new.processed_at := null;
  if new.bank_code is not null and new.bank_code !~ '^[0-9]{8}$' then new.bank_code := null; end if;
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

-- Users may not edit a withdrawal after submitting it (amount, bank, status...),
-- and may only delete their own still-pending, never-sent request (the browser
-- uses this to roll back when the wallet debit fails).
create or replace function public.protect_withdrawals() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'Withdrawal requests cannot be changed once submitted';
  end if;
  if old.status <> 'pending' or old.order_sn is not null then
    raise exception 'This withdrawal can no longer be cancelled';
  end if;
  return old;
end; $$;
drop trigger if exists protect_withdrawals on public.withdrawals;
create trigger protect_withdrawals before update or delete on public.withdrawals
  for each row execute function public.protect_withdrawals();

-- ---------- Manual approve/reject never touch gateway deposits ----------
create or replace function public.admin_approve_deposit(p_deposit uuid) returns void
language plpgsql security definer set search_path = public as $$
declare d public.deposits; ref uuid; pct numeric; bonus numeric;
begin
  if not public.is_admin() then raise exception 'Admin privileges required'; end if;
  update public.deposits set status = 'approved', credited_amount = amount, processed_at = now()
   where id = p_deposit and status = 'pending' and method = 'manual' returning * into d;
  if not found then raise exception 'Deposit not found, already processed, or paid through the gateway'; end if;

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
  update public.deposits set status = 'rejected', processed_at = now()
   where id = p_deposit and status = 'pending' and method = 'manual';
  if not found then raise exception 'Deposit not found, already processed, or paid through the gateway'; end if;
end; $$;

-- ---------- Gateway callbacks (service role only) ----------
-- Payin for a user deposit. Credits the wallet exactly once.
-- Amount credited (decision, documented in README):
--   amount_paid >= order amount -> credit the order amount (overpayment is not credited)
--   amount_paid <  order amount -> credit amount_paid (partial payment)
--   amount_paid missing         -> credit the order amount (status 1 + valid signature)
-- Referral commission is paid on the credited amount, exactly as admin_approve_deposit does.
create or replace function public.gateway_apply_payin(
  p_order_sn text, p_platform_osn text, p_status int, p_amount_paid numeric,
  p_message text, p_utr text, p_payload jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare d public.deposits; credit numeric; ref uuid; pct numeric; bonus numeric;
begin
  select * into d from public.deposits where order_sn = p_order_sn and method = 'gateway' for update;
  if not found then return 'not_found'; end if;
  if d.platform_osn is not null and p_platform_osn is not null and d.platform_osn <> p_platform_osn then
    return 'osn_mismatch';
  end if;
  if d.status = 'approved' then return 'duplicate'; end if;

  if p_status is distinct from 1 then
    update public.deposits
       set status = case when status = 'pending' then 'failed' else status end,
           platform_osn = coalesce(platform_osn, p_platform_osn),
           gateway_status = p_status, gateway_message = p_message, utr = coalesce(p_utr, utr),
           amount_paid = coalesce(p_amount_paid, amount_paid),
           callback_payload = p_payload, processed_at = now()
     where id = d.id;
    if d.status = 'pending' then
      insert into public.notifications (user_id, title, message)
      values (d.user_id, 'Deposit Not Completed',
              'Your deposit of ₦' || to_char(d.amount,'FM999,999,999,990') || ' was not completed by the payment gateway. No money was added to your wallet.');
      return 'failed_recorded';
    end if;
    return 'ignored';
  end if;

  credit := case
              when p_amount_paid is null then d.amount
              when p_amount_paid >= d.amount then d.amount
              else round(p_amount_paid, 2)
            end;
  if credit <= 0 then
    update public.deposits set status = 'failed', gateway_status = p_status,
           gateway_message = coalesce(p_message, '') || ' (paid amount was zero)',
           platform_osn = coalesce(platform_osn, p_platform_osn), amount_paid = p_amount_paid,
           callback_payload = p_payload, processed_at = now()
     where id = d.id;
    return 'failed_recorded';
  end if;

  update public.deposits
     set status = 'approved', credited_amount = credit, amount_paid = p_amount_paid,
         platform_osn = coalesce(platform_osn, p_platform_osn),
         gateway_status = p_status, gateway_message = p_message, utr = p_utr,
         callback_payload = p_payload, processed_at = now()
   where id = d.id;

  update public.wallets set available_balance = available_balance + credit, updated_at = now() where user_id = d.user_id;
  insert into public.transactions (user_id, amount, type, description, reference)
  values (d.user_id, credit, 'deposit',
          'Gateway deposit' || case when credit < d.amount then ' (partial payment of ₦' || to_char(d.amount,'FM999,999,999,990.00') || ' order)' else '' end,
          d.order_sn);

  select referred_by into ref from public.profiles where id = d.user_id;
  if ref is not null then
    pct := coalesce((select referral_commission_pct from public.site_settings where id = 1), 20);
    bonus := round(credit * pct / 100, 2);
    if bonus > 0 then
      update public.wallets set available_balance = available_balance + bonus, updated_at = now() where user_id = ref;
      insert into public.transactions (user_id, amount, type, description)
      values (ref, bonus, 'referral_bonus',
              trim(to_char(pct,'FM990.##')) || '% referral bonus from a downstream deposit of ₦' || to_char(credit,'FM999,999,999,990'));
    end if;
  end if;

  insert into public.notifications (user_id, title, message)
  values (d.user_id, 'Deposit Successful',
          'Your deposit of ₦' || to_char(credit,'FM999,999,999,990.00') || ' has been confirmed and credited to your wallet.');
  return 'credited';
end; $$;

-- Payout result for a user withdrawal. 1 = paid, 9 = failed (refund once).
create or replace function public.gateway_apply_payout(
  p_order_sn text, p_platform_osn text, p_status int, p_amount numeric,
  p_message text, p_utr text, p_payload jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare w public.withdrawals;
begin
  select * into w from public.withdrawals where order_sn = p_order_sn for update;
  if not found then return 'not_found'; end if;
  if w.payout_amount is null or round(w.payout_amount, 2) <> round(p_amount, 2) then return 'amount_mismatch'; end if;
  if w.platform_osn is not null and p_platform_osn is not null and w.platform_osn <> p_platform_osn then
    return 'osn_mismatch';
  end if;
  if w.status in ('approved','failed','rejected') then return 'duplicate'; end if;
  if w.status <> 'processing' then return 'ignored'; end if;

  if p_status = 1 then
    update public.withdrawals
       set status = 'approved', processed_at = now(), platform_osn = coalesce(platform_osn, p_platform_osn),
           gateway_status = p_status, gateway_message = p_message, utr = p_utr, callback_payload = p_payload
     where id = w.id;
    insert into public.notifications (user_id, title, message)
    values (w.user_id, 'Withdrawal Paid',
            'Your withdrawal of ₦' || to_char(w.payout_amount,'FM999,999,999,990.00') || ' has been sent to your bank account' ||
            case when w.account_number is not null then ' (' || w.account_number || ')' else '' end || '.');
    return 'completed';
  elsif p_status = 9 then
    update public.withdrawals
       set status = 'failed', processed_at = now(), platform_osn = coalesce(platform_osn, p_platform_osn),
           gateway_status = p_status, gateway_message = p_message, utr = p_utr, callback_payload = p_payload
     where id = w.id;
    update public.wallets set available_balance = available_balance + w.amount, updated_at = now() where user_id = w.user_id;
    insert into public.transactions (user_id, amount, type, description, reference)
    values (w.user_id, w.amount, 'withdrawal_refund', 'Refund: withdrawal payout failed at the gateway', w.order_sn);
    insert into public.notifications (user_id, title, message)
    values (w.user_id, 'Withdrawal Failed',
            'Your withdrawal of ₦' || to_char(w.amount,'FM999,999,999,990.00') || ' could not be paid out and has been refunded to your wallet.' ||
            case when coalesce(p_message,'') <> '' then ' Reason: ' || p_message else '' end);
    return 'refunded';
  end if;
  update public.withdrawals set gateway_status = p_status, gateway_message = p_message where id = w.id;
  return 'ignored';
end; $$;

-- Admin top-up (payin) or admin payout result. Never touches user wallets.
create or replace function public.gateway_apply_admin(
  p_order_sn text, p_kind text, p_platform_osn text, p_status int, p_amount numeric, p_amount_paid numeric,
  p_message text, p_utr text, p_payload jsonb
) returns text
language plpgsql security definer set search_path = public as $$
declare g public.gateway_admin_transactions; new_status text;
begin
  select * into g from public.gateway_admin_transactions where order_sn = p_order_sn and kind = p_kind for update;
  if not found then return 'not_found'; end if;
  if g.platform_osn is not null and p_platform_osn is not null and g.platform_osn <> p_platform_osn then
    return 'osn_mismatch';
  end if;
  if p_kind = 'payout' and round(g.amount, 2) <> round(p_amount, 2) then return 'amount_mismatch'; end if;
  if g.status = 'completed' then return 'duplicate'; end if;
  if g.status = 'failed' and p_status is distinct from 1 then return 'duplicate'; end if;

  if p_status = 1 then new_status := 'completed';
  elsif p_kind = 'payout' and p_status = 9 then new_status := 'failed';
  elsif p_kind = 'topup' then new_status := 'failed';
  else
    update public.gateway_admin_transactions set gateway_status = p_status, gateway_message = p_message, updated_at = now() where id = g.id;
    return 'ignored';
  end if;

  update public.gateway_admin_transactions
     set status = new_status, platform_osn = coalesce(platform_osn, p_platform_osn),
         amount_paid = coalesce(p_amount_paid, amount_paid),
         gateway_status = p_status, gateway_message = p_message, utr = coalesce(p_utr, utr),
         callback_payload = p_payload, updated_at = now()
   where id = g.id;
  return new_status;
end; $$;

revoke execute on function public.gateway_apply_payin(text,text,int,numeric,text,text,jsonb) from public, anon, authenticated;
revoke execute on function public.gateway_apply_payout(text,text,int,numeric,text,text,jsonb) from public, anon, authenticated;
revoke execute on function public.gateway_apply_admin(text,text,text,int,numeric,numeric,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.gateway_apply_payin(text,text,int,numeric,text,text,jsonb) to service_role;
grant execute on function public.gateway_apply_payout(text,text,int,numeric,text,text,jsonb) to service_role;
grant execute on function public.gateway_apply_admin(text,text,text,int,numeric,numeric,text,text,jsonb) to service_role;

-- Helps the deposit result page and the admin lists.
create index if not exists deposits_method_created_idx on public.deposits (method, created_at desc);
create index if not exists withdrawals_method_created_idx on public.withdrawals (method, created_at desc);

-- ============================================================================
-- Security lockdown (Nov 2026): users can no longer write money tables
-- directly. Every money-moving user action goes through a SECURITY DEFINER
-- RPC that validates server-side with auth.uid(), locks the wallet row and
-- writes the debit/credit, the row, and the transaction log atomically.
-- ============================================================================

-- ---------- 0. Hygiene: API roles never need TRUNCATE / TRIGGER / REFERENCES
revoke truncate, trigger, references on all tables in schema public from anon, authenticated;

-- ---------- 1. wallets: read own only; writes only via definer functions / service role
drop policy if exists own_all on public.wallets;
drop policy if exists active_only_upd on public.wallets;
drop policy if exists own_select on public.wallets;
create policy own_select on public.wallets for select using (user_id = auth.uid());
revoke insert, update, delete on public.wallets from anon, authenticated;

-- ---------- 2. investments: read own (plus referral_active); create via user_invest()
drop policy if exists own_all on public.investments;
drop policy if exists own_select on public.investments;
create policy own_select on public.investments for select using (user_id = auth.uid());

-- ---------- 3. transactions: no self-inserted ledger rows
drop policy if exists own_ins on public.transactions;

-- ---------- 4. withdrawals: read own; create via user_request_withdrawal()
drop policy if exists own_all on public.withdrawals;
drop policy if exists own_select on public.withdrawals;
create policy own_select on public.withdrawals for select using (user_id = auth.uid());
revoke insert, update, delete on public.withdrawals from anon, authenticated;

-- ---------- 5. deposits: read own; manual requests via user_create_deposit()
drop policy if exists own_ins on public.deposits;

-- ---------- 6. gift codes: users can neither list nor edit codes
drop policy if exists read_codes on public.gift_codes;
drop policy if exists use_codes on public.gift_codes;
drop policy if exists active_only_upd on public.gift_codes;
drop policy if exists own_all on public.gift_redemptions;
drop policy if exists own_select on public.gift_redemptions;
create policy own_select on public.gift_redemptions for select using (user_id = auth.uid());

-- ---------- 7. notifications: read own, mark read, delete own; never create
drop policy if exists own_all on public.notifications;
drop policy if exists own_select on public.notifications;
drop policy if exists own_update on public.notifications;
drop policy if exists own_delete on public.notifications;
create policy own_select on public.notifications for select using (user_id = auth.uid());
create policy own_update on public.notifications for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_delete on public.notifications for delete using (user_id = auth.uid());
-- Column-level: non-admin updates can only touch is_read. Admins insert through
-- admin_all (INSERT stays granted) and never update notifications from the UI.
revoke update on public.notifications from anon, authenticated;
grant update (is_read) on public.notifications to authenticated;

-- ---------- 8. profiles: users may edit name/phone/avatar/terms only
create or replace function public.protect_role()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.id := old.id;
    new.role := old.role;
    new.status := old.status;
    new.status_reason := old.status_reason;
    new.status_changed_at := old.status_changed_at;
    new.admin_notes := old.admin_notes;
    new.email := old.email;
    new.referral_code := old.referral_code;
    new.referred_by := old.referred_by;
    new.created_at := old.created_at;
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  new.updated_at := now();
  return new;
end; $$;

-- ---------- 9. Functions anyone could call
-- increment_balance(row_id, amt) credited ANY wallet by ANY amount for anon/authenticated.
revoke execute on function public.increment_balance(uuid, numeric) from public, anon, authenticated;
grant execute on function public.increment_balance(uuid, numeric) to service_role;
-- Daily earnings run from pg_cron as postgres only.
revoke execute on function public.process_daily_earnings() from public, anon, authenticated;
grant execute on function public.process_daily_earnings() to service_role;
-- Trigger functions are not callable as RPCs anyway; tidy their grants.
revoke execute on function public.enforce_deposit_limits() from public, anon, authenticated;
revoke execute on function public.enforce_withdrawal_rules() from public, anon, authenticated;
revoke execute on function public.protect_withdrawals() from public, anon, authenticated;
revoke execute on function public.protect_role() from public, anon, authenticated;
revoke execute on function public.touch_site_settings() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.handle_new_user() to supabase_auth_admin, service_role;
-- Admin RPCs: authenticated may call, each checks is_admin(); never anon.
revoke execute on function public.admin_set_wallet(uuid,numeric,numeric,numeric,numeric,numeric,numeric,numeric,text) from public, anon;
revoke execute on function public.admin_approve_deposit(uuid) from public, anon;
revoke execute on function public.admin_reject_deposit(uuid) from public, anon;

-- ---------- 10. User RPCs ---------------------------------------------------

-- Withdrawal request: validates and debits available_balance atomically.
-- The enforce_withdrawal_rules trigger still runs on the insert (min/max,
-- days/hours, fee, sanitised gateway columns); the checks below give the
-- same errors before anything is written. The row is 'pending' and stays
-- compatible with admin Complete / Reject (refund) / Send to gateway.
create or replace function public.user_request_withdrawal(
  p_amount numeric, p_bank_name text, p_bank_code text, p_account_number text, p_account_name text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  s public.site_settings;
  w public.wallets;
  amt numeric := round(coalesce(p_amount, 0), 2);
  acct text := regexp_replace(coalesce(p_account_number, ''), '\s', '', 'g');
  bname text := nullif(trim(coalesce(p_bank_name, '')), '');
  aname text := nullif(trim(coalesce(p_account_name, '')), '');
  bcode text := nullif(trim(coalesce(p_bank_code, '')), '');
  lagos timestamp := now() at time zone 'Africa/Lagos';
  t time := (now() at time zone 'Africa/Lagos')::time;
  wid uuid;
begin
  if uid is null then raise exception 'Please sign in again.'; end if;
  if not public.is_active_user() then raise exception 'Your account is not active. Contact support.'; end if;
  if amt <= 0 then raise exception 'Enter a valid amount.'; end if;
  if bname is null then raise exception 'Select your bank.'; end if;
  if acct !~ '^[0-9]{10}$' then raise exception 'Enter your 10-digit account number.'; end if;
  if aname is null then raise exception 'Enter the account holder name.'; end if;
  if bcode is not null and bcode !~ '^[0-9]{8}$' then bcode := null; end if;

  select * into s from public.site_settings where id = 1;
  if found then
    if amt < s.min_withdrawal then
      raise exception 'Minimum withdrawal is ₦%', to_char(s.min_withdrawal,'FM999,999,999,990');
    end if;
    if s.max_withdrawal is not null and s.max_withdrawal > 0 and amt > s.max_withdrawal then
      raise exception 'Maximum withdrawal is ₦%', to_char(s.max_withdrawal,'FM999,999,999,990');
    end if;
    if not (extract(dow from lagos)::int = any(s.withdrawal_days)) or
       (case when s.withdrawal_open_time <= s.withdrawal_close_time
             then t < s.withdrawal_open_time or t > s.withdrawal_close_time + interval '59 seconds'
             else t < s.withdrawal_open_time and t > s.withdrawal_close_time + interval '59 seconds' end) then
      raise exception 'Withdrawals are closed right now';
    end if;
  end if;

  if not exists (select 1 from public.investments where user_id = uid and status = 'active') then
    raise exception 'You need at least one active investment before you can withdraw.';
  end if;

  select * into w from public.wallets where user_id = uid for update;
  if not found then raise exception 'Wallet not found.'; end if;
  if w.available_balance < amt then raise exception 'Insufficient wallet balance.'; end if;

  update public.wallets set available_balance = available_balance - amt, updated_at = now() where user_id = uid;

  insert into public.withdrawals (user_id, amount, charge, bank_name, bank_code, account_number, account_name, status)
  values (uid, amt, round(amt * coalesce(s.withdrawal_fee_pct, 0) / 100, 2), bname, bcode, acct, aname, 'pending')
  returning id into wid;   -- enforce_withdrawal_rules recomputes the same charge for non-admins

  insert into public.transactions (user_id, amount, type, description)
  values (uid, amt, 'withdrawal', 'Withdrawal request to ' || bname || ' (' || acct || ') — pending');

  insert into public.notifications (user_id, title, message)
  values (uid, 'Withdrawal Pending', 'Your request for ₦' || to_char(amt,'FM999,999,999,990.00') || ' is being reviewed.');

  return wid;
end; $$;

-- Investment purchase: plan must be active, amount is the plan price.
create or replace function public.user_invest(p_plan_id uuid, p_amount numeric default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  p public.investment_plans;
  w public.wallets;
  amt numeric;
  iid uuid;
begin
  if uid is null then raise exception 'Please sign in again.'; end if;
  if not public.is_active_user() then raise exception 'Your account is not active. Contact support.'; end if;

  select * into p from public.investment_plans where id = p_plan_id;
  if not found or not coalesce(p.is_active, false) then raise exception 'This plan is not available.'; end if;
  amt := round(coalesce(p.price, 0), 2);
  if amt <= 0 or coalesce(p.duration_days, 0) <= 0 or coalesce(p.daily_roi_pct, 0) <= 0 then
    raise exception 'This plan is not available.';
  end if;
  if p_amount is not null and round(p_amount, 2) <> amt then
    raise exception 'This plan costs ₦%', to_char(amt,'FM999,999,999,990');
  end if;
  if p.category = 'professional'
     and not exists (select 1 from public.investments where user_id = uid and status = 'active') then
    raise exception 'You need at least one active investment before purchasing a Professional plan.';
  end if;

  select * into w from public.wallets where user_id = uid for update;
  if not found then raise exception 'Wallet not found.'; end if;
  if w.available_balance < amt then raise exception 'Insufficient wallet balance.'; end if;

  update public.wallets set available_balance = available_balance - amt, updated_at = now() where user_id = uid;

  insert into public.investments (user_id, plan_id, amount_invested, daily_earning_amount, remaining_days, status)
  values (uid, p.id, amt, round(amt * p.daily_roi_pct / 100, 2), p.duration_days, 'active')
  returning id into iid;

  insert into public.transactions (user_id, amount, type, description)
  values (uid, amt, 'investment', 'Committed ₦' || to_char(amt,'FM999999999990.##') || ' to the ' || coalesce(p.name, 'plan'));

  return iid;
end; $$;

-- Gift code redemption (gift page and the optional code at sign-up).
-- One redemption per user per code (unique index), usage limit and expiry
-- enforced under a row lock. p_signup=true mirrors the old sign-up flow,
-- which also added the amount to bonus_balance.
create or replace function public.user_redeem_gift_code(p_code text, p_signup boolean default false)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  c text := upper(trim(coalesce(p_code, '')));
  g public.gift_codes;
begin
  if uid is null then raise exception 'Please sign in again.'; end if;
  if not public.is_active_user() then raise exception 'Your account is not active. Contact support.'; end if;
  if c = '' then raise exception 'Enter a reward code.'; end if;

  select * into g from public.gift_codes where upper(code) = c for update;
  if not found or not coalesce(g.is_active, false) then raise exception 'Invalid or inactive reward code.'; end if;
  if g.expiry_date is not null and g.expiry_date < now() then raise exception 'This reward code has expired.'; end if;
  if g.usage_limit is not null and coalesce(g.current_usage, 0) >= g.usage_limit then
    raise exception 'This code has reached its maximum usage limit.';
  end if;
  if coalesce(g.amount, 0) <= 0 then raise exception 'Invalid or inactive reward code.'; end if;
  if exists (select 1 from public.gift_redemptions where user_id = uid and gift_code_id = g.id) then
    raise exception 'You have already redeemed this reward.';
  end if;

  perform 1 from public.wallets where user_id = uid for update;
  if not found then raise exception 'Wallet not found.'; end if;

  insert into public.gift_redemptions (user_id, gift_code_id) values (uid, g.id);
  update public.gift_codes set current_usage = coalesce(current_usage, 0) + 1, used_by = uid where id = g.id;
  update public.wallets
     set available_balance = available_balance + g.amount,
         bonus_balance = bonus_balance + case when p_signup then g.amount else 0 end,
         updated_at = now()
   where user_id = uid;

  insert into public.transactions (user_id, amount, type, description)
  values (uid, g.amount, 'gift_code',
          case when p_signup then 'Redeemed gift code: ' else 'Redeemed Gift Reward: ' end || g.code);
  insert into public.notifications (user_id, title, message)
  values (uid, 'Gift Reward Credited!',
          'Successfully redeemed code ' || g.code || '. ₦' || to_char(g.amount,'FM999,999,999,990.00') || ' added to your wallet.');
  return g.amount;
end; $$;

-- Manual (bank transfer) deposit request: pending row + ledger + notification.
-- No money moves until an admin approves (admin_approve_deposit). The
-- enforce_deposit_limits trigger still applies min/max and sanitises the row.
create or replace function public.user_create_deposit(p_amount numeric, p_account_name text, p_bank_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  amt numeric := round(coalesce(p_amount, 0), 2);
  aname text := nullif(trim(coalesce(p_account_name, '')), '');
  bname text := nullif(trim(coalesce(p_bank_name, '')), '');
  did uuid;
begin
  if uid is null then raise exception 'Please sign in again.'; end if;
  if not public.is_active_user() then raise exception 'Your account is not active. Contact support.'; end if;
  if amt <= 0 then raise exception 'Enter a valid amount.'; end if;
  if aname is null or bname is null then raise exception 'Please enter both the account name and bank name.'; end if;

  insert into public.deposits (user_id, amount, account_name, bank_name, status)
  values (uid, amt, aname, bname, 'pending') returning id into did;

  insert into public.transactions (user_id, amount, type, description)
  values (uid, amt, 'deposit', 'Deposit from ' || aname || ' (' || bname || ') — pending');
  insert into public.notifications (user_id, title, message)
  values (uid, 'Deposit Received',
          'Your deposit of ₦' || to_char(amt,'FM999,999,999,990') || ' is being verified. It will reflect in your wallet once approved.');
  return did;
end; $$;

revoke execute on function public.user_request_withdrawal(numeric,text,text,text,text) from public, anon;
revoke execute on function public.user_invest(uuid,numeric) from public, anon;
revoke execute on function public.user_redeem_gift_code(text,boolean) from public, anon;
revoke execute on function public.user_create_deposit(numeric,text,text) from public, anon;
grant execute on function public.user_request_withdrawal(numeric,text,text,text,text) to authenticated;
grant execute on function public.user_invest(uuid,numeric) to authenticated;
grant execute on function public.user_redeem_gift_code(text,boolean) to authenticated;
grant execute on function public.user_create_deposit(numeric,text,text) to authenticated;

-- =====================================================================
-- Privacy: referrers no longer read referred users' profile rows.
-- * profiles SELECT is own-row only (admins keep full access via admin_all).
-- * investments.referral_active dropped (leaked referred users' investments).
-- * Referral page reads a masked summary via SECURITY DEFINER RPCs.
-- * admin_notes moves to an admin-only table (users can't read their own notes).
-- * Referral bonus transactions now carry reference = 'referral:<referred uuid>'
--   so commission can be attributed per referral.
-- =====================================================================

drop policy if exists own_select on public.profiles;
create policy own_select on public.profiles for select using (id = auth.uid());

drop policy if exists referral_active on public.investments;

-- ---------- Admin-only notes ----------
create table if not exists public.profile_admin_notes (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table public.profile_admin_notes enable row level security;
drop policy if exists admin_all on public.profile_admin_notes;
create policy admin_all on public.profile_admin_notes for all using (public.is_admin()) with check (public.is_admin());
revoke all on public.profile_admin_notes from anon;
grant select, insert, update, delete on public.profile_admin_notes to authenticated;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'profiles' and column_name = 'admin_notes') then
    insert into public.profile_admin_notes (user_id, notes)
    select id, admin_notes from public.profiles where admin_notes is not null
    on conflict (user_id) do update set notes = excluded.notes;
  end if;
end $$;

create or replace function public.protect_role() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.id := old.id;
    new.role := old.role;
    new.status := old.status;
    new.status_reason := old.status_reason;
    new.status_changed_at := old.status_changed_at;
    new.email := old.email;
    new.referral_code := old.referral_code;
    new.referred_by := old.referred_by;
    new.created_at := old.created_at;
  end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
  end if;
  new.updated_at := now();
  return new;
end; $$;

alter table public.profiles drop column if exists admin_notes;

-- ---------- Referral RPCs (masked, caller's own network only) ----------
create or replace function public.mask_name(p_name text) returns text
language sql immutable set search_path = public as $$
  select case
    when coalesce(trim(p_name), '') = '' then 'Member'
    when array_length(regexp_split_to_array(trim(p_name), '\s+'), 1) = 1 then trim(p_name)
    else (regexp_split_to_array(trim(p_name), '\s+'))[1] || ' ' ||
         upper(left((regexp_split_to_array(trim(p_name), '\s+'))[array_length(regexp_split_to_array(trim(p_name), '\s+'), 1)], 1)) || '.'
  end;
$$;

create or replace function public.my_referrals()
returns table (display_name text, joined_at timestamptz, is_active boolean, has_invested boolean, commission_earned numeric)
language sql stable security definer set search_path = public as $$
  select public.mask_name(p.full_name),
         p.created_at,
         exists (select 1 from public.investments i where i.user_id = p.id and i.status = 'active'),
         exists (select 1 from public.investments i where i.user_id = p.id),
         coalesce((select sum(t.amount) from public.transactions t
                    where t.user_id = auth.uid() and t.type = 'referral_bonus'
                      and t.reference = 'referral:' || p.id::text), 0)
    from public.profiles p
   where auth.uid() is not null and p.referred_by = auth.uid()
   order by p.created_at desc;
$$;

create or replace function public.my_referral_tiers()
returns table (direct_count int, secondary_count int, tertiary_count int)
language sql stable security definer set search_path = public as $$
  with l1 as (select id from public.profiles where auth.uid() is not null and referred_by = auth.uid()),
       l2 as (select id from public.profiles where referred_by in (select id from l1)),
       l3 as (select id from public.profiles where referred_by in (select id from l2))
  select (select count(*) from l1)::int, (select count(*) from l2)::int, (select count(*) from l3)::int;
$$;

revoke execute on function public.my_referrals() from public, anon;
revoke execute on function public.my_referral_tiers() from public, anon;
grant execute on function public.my_referrals() to authenticated;
grant execute on function public.my_referral_tiers() to authenticated;

-- Referral bonuses carry the referred user's id in transactions.reference
CREATE OR REPLACE FUNCTION public.admin_approve_deposit(p_deposit uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.deposits; ref uuid; pct numeric; bonus numeric;
begin
  if not public.is_admin() then raise exception 'Admin privileges required'; end if;
  update public.deposits set status = 'approved', credited_amount = amount, processed_at = now()
   where id = p_deposit and status = 'pending' and method = 'manual' returning * into d;
  if not found then raise exception 'Deposit not found, already processed, or paid through the gateway'; end if;

  update public.wallets set available_balance = available_balance + d.amount, updated_at = now() where user_id = d.user_id;

  select referred_by into ref from public.profiles where id = d.user_id;
  if ref is not null then
    pct := coalesce((select referral_commission_pct from public.site_settings where id = 1), 20);
    bonus := round(d.amount * pct / 100, 2);
    if bonus > 0 then
      update public.wallets set available_balance = available_balance + bonus, updated_at = now() where user_id = ref;
      insert into public.transactions (user_id, amount, type, reference, description)
      values (ref, bonus, 'referral_bonus', 'referral:' || d.user_id::text,
              trim(to_char(pct,'FM990.##')) || '% referral bonus from a downstream deposit of ₦' || to_char(d.amount,'FM999,999,999,990'));
    end if;
  end if;

  insert into public.notifications (user_id, title, message)
  values (d.user_id, 'Deposit Approved',
          'Your deposit of ₦' || to_char(d.amount,'FM999,999,999,990') || ' has been approved and credited to your wallet.');
end; $function$;

CREATE OR REPLACE FUNCTION public.gateway_apply_payin(p_order_sn text, p_platform_osn text, p_status integer, p_amount_paid numeric, p_message text, p_utr text, p_payload jsonb)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d public.deposits; credit numeric; ref uuid; pct numeric; bonus numeric;
begin
  select * into d from public.deposits where order_sn = p_order_sn and method = 'gateway' for update;
  if not found then return 'not_found'; end if;
  if d.platform_osn is not null and p_platform_osn is not null and d.platform_osn <> p_platform_osn then
    return 'osn_mismatch';
  end if;
  if d.status = 'approved' then return 'duplicate'; end if;

  if p_status is distinct from 1 then
    update public.deposits
       set status = case when status = 'pending' then 'failed' else status end,
           platform_osn = coalesce(platform_osn, p_platform_osn),
           gateway_status = p_status, gateway_message = p_message, utr = coalesce(p_utr, utr),
           amount_paid = coalesce(p_amount_paid, amount_paid),
           callback_payload = p_payload, processed_at = now()
     where id = d.id;
    if d.status = 'pending' then
      insert into public.notifications (user_id, title, message)
      values (d.user_id, 'Deposit Not Completed',
              'Your deposit of ₦' || to_char(d.amount,'FM999,999,999,990') || ' was not completed by the payment gateway. No money was added to your wallet.');
      return 'failed_recorded';
    end if;
    return 'ignored';
  end if;

  credit := case
              when p_amount_paid is null then d.amount
              when p_amount_paid >= d.amount then d.amount
              else round(p_amount_paid, 2)
            end;
  if credit <= 0 then
    update public.deposits set status = 'failed', gateway_status = p_status,
           gateway_message = coalesce(p_message, '') || ' (paid amount was zero)',
           platform_osn = coalesce(platform_osn, p_platform_osn), amount_paid = p_amount_paid,
           callback_payload = p_payload, processed_at = now()
     where id = d.id;
    return 'failed_recorded';
  end if;

  update public.deposits
     set status = 'approved', credited_amount = credit, amount_paid = p_amount_paid,
         platform_osn = coalesce(platform_osn, p_platform_osn),
         gateway_status = p_status, gateway_message = p_message, utr = p_utr,
         callback_payload = p_payload, processed_at = now()
   where id = d.id;

  update public.wallets set available_balance = available_balance + credit, updated_at = now() where user_id = d.user_id;
  insert into public.transactions (user_id, amount, type, description, reference)
  values (d.user_id, credit, 'deposit',
          'Gateway deposit' || case when credit < d.amount then ' (partial payment of ₦' || to_char(d.amount,'FM999,999,999,990.00') || ' order)' else '' end,
          d.order_sn);

  select referred_by into ref from public.profiles where id = d.user_id;
  if ref is not null then
    pct := coalesce((select referral_commission_pct from public.site_settings where id = 1), 20);
    bonus := round(credit * pct / 100, 2);
    if bonus > 0 then
      update public.wallets set available_balance = available_balance + bonus, updated_at = now() where user_id = ref;
      insert into public.transactions (user_id, amount, type, reference, description)
      values (ref, bonus, 'referral_bonus', 'referral:' || d.user_id::text,
              trim(to_char(pct,'FM990.##')) || '% referral bonus from a downstream deposit of ₦' || to_char(credit,'FM999,999,999,990'));
    end if;
  end if;

  insert into public.notifications (user_id, title, message)
  values (d.user_id, 'Deposit Successful',
          'Your deposit of ₦' || to_char(credit,'FM999,999,999,990.00') || ' has been confirmed and credited to your wallet.');
  return 'credited';
end; $function$;

-- ============================================================================
-- 2026-11-03 · Deposit mode split + withdrawals always gateway-based
-- * site_settings.deposit_mode ('manual'|'gateway') is the deposit switch
--   (admin Gateway page). payment_mode stays as a legacy alias, kept in sync
--   both ways by a trigger, so older code reading it keeps working.
-- * Withdrawals never depend on the deposit mode: users pick a bank from the
--   Afrstar list (bank_code required); an admin approves every request with
--   Send to gateway (payout), Mark as paid (paid outside the gateway) or
--   Reject (refund).
-- * Mark-as-paid and Reject run in service-role-only functions that lock the
--   withdrawal row and (for refunds) the wallet row, in one transaction.
-- ============================================================================
alter table public.site_settings add column if not exists deposit_mode text;
update public.site_settings set deposit_mode = coalesce(payment_mode, 'manual') where deposit_mode is null;
alter table public.site_settings alter column deposit_mode set default 'manual';
alter table public.site_settings alter column deposit_mode set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'site_settings_deposit_mode_check') then
    alter table public.site_settings add constraint site_settings_deposit_mode_check
      check (deposit_mode in ('manual','gateway'));
  end if;
end $$;
comment on column public.site_settings.deposit_mode is 'Deposit method: manual bank transfer or gateway (Afrstar). Switched on admin/gateway.html.';
comment on column public.site_settings.payment_mode is 'Legacy alias of deposit_mode (kept in sync by trigger sync_deposit_mode).';

create or replace function public.sync_deposit_mode() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.deposit_mode := coalesce(new.deposit_mode, new.payment_mode, 'manual');
  elsif new.deposit_mode is distinct from old.deposit_mode then
    null;                                   -- deposit_mode wins
  elsif new.payment_mode is distinct from old.payment_mode then
    new.deposit_mode := new.payment_mode;   -- legacy writer
  end if;
  new.payment_mode := new.deposit_mode;
  return new;
end; $$;
drop trigger if exists sync_deposit_mode on public.site_settings;
create trigger sync_deposit_mode before insert or update on public.site_settings
  for each row execute function public.sync_deposit_mode();
revoke execute on function public.sync_deposit_mode() from public, anon, authenticated;

alter table public.withdrawals add column if not exists processed_by uuid references public.profiles(id) on delete set null;

-- Mark as paid: the admin paid this pending request outside the gateway.
-- The wallet was debited at request time, so only the status changes.
create or replace function public.admin_mark_withdrawal_paid(p_withdrawal uuid, p_admin uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.withdrawals;
begin
  select * into w from public.withdrawals where id = p_withdrawal for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if w.status <> 'pending' then return jsonb_build_object('result', 'conflict', 'status', w.status); end if;
  update public.withdrawals
     set status = 'approved', method = 'manual', processed_at = now(), processed_by = p_admin,
         gateway_message = 'Marked as paid by admin (paid outside the gateway)'
   where id = w.id;
  insert into public.notifications (user_id, title, message)
  values (w.user_id, 'Withdrawal Paid',
          'Your withdrawal of ₦' || to_char(w.amount - coalesce(w.charge, 0),'FM999,999,999,990.00') ||
          ' has been paid to your bank account' ||
          case when w.account_number is not null then ' (' || w.account_number || ')' else '' end || '.');
  return jsonb_build_object('result', 'approved', 'status', 'approved');
end; $$;

-- Reject & refund: pending, or a gateway send whose outcome is unknown
-- (processing with no platform order number, after checking the portal).
-- Locks the withdrawal and the wallet; the refund is one in-place update.
create or replace function public.admin_reject_withdrawal(p_withdrawal uuid, p_admin uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare w public.withdrawals; bal numeric;
begin
  select * into w from public.withdrawals where id = p_withdrawal for update;
  if not found then return jsonb_build_object('result', 'not_found'); end if;
  if not (w.status = 'pending' or (w.status = 'processing' and w.platform_osn is null)) then
    return jsonb_build_object('result', 'conflict', 'status', w.status);
  end if;
  perform 1 from public.wallets where user_id = w.user_id for update;
  if not found then raise exception 'Wallet not found for this user.'; end if;
  update public.withdrawals
     set status = 'rejected', processed_at = now(), processed_by = p_admin
   where id = w.id;
  update public.wallets set available_balance = available_balance + w.amount, updated_at = now()
   where user_id = w.user_id returning available_balance into bal;
  insert into public.transactions (user_id, amount, type, description, reference)
  values (w.user_id, w.amount, 'withdrawal_refund', 'Refund: withdrawal rejected by admin', coalesce(w.order_sn, w.id::text));
  insert into public.notifications (user_id, title, message)
  values (w.user_id, 'Withdrawal Rejected',
          'Your withdrawal of ₦' || to_char(w.amount,'FM999,999,999,990') || ' was rejected and refunded to your wallet.');
  return jsonb_build_object('result', 'rejected', 'status', 'rejected', 'refunded_balance', bal);
end; $$;
revoke execute on function public.admin_mark_withdrawal_paid(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.admin_reject_withdrawal(uuid, uuid) from public, anon, authenticated;
grant execute on function public.admin_mark_withdrawal_paid(uuid, uuid) to service_role;
grant execute on function public.admin_reject_withdrawal(uuid, uuid) to service_role;

-- Withdrawal requests now require a bank from the Afrstar list.
create or replace function public.user_request_withdrawal(
  p_amount numeric, p_bank_name text, p_bank_code text, p_account_number text, p_account_name text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  s public.site_settings;
  w public.wallets;
  amt numeric := round(coalesce(p_amount, 0), 2);
  acct text := regexp_replace(coalesce(p_account_number, ''), '\s', '', 'g');
  bname text := nullif(trim(coalesce(p_bank_name, '')), '');
  aname text := nullif(trim(coalesce(p_account_name, '')), '');
  bcode text := nullif(trim(coalesce(p_bank_code, '')), '');
  lagos timestamp := now() at time zone 'Africa/Lagos';
  t time := (now() at time zone 'Africa/Lagos')::time;
  wid uuid;
begin
  if uid is null then raise exception 'Please sign in again.'; end if;
  if not public.is_active_user() then raise exception 'Your account is not active. Contact support.'; end if;
  if amt <= 0 then raise exception 'Enter a valid amount.'; end if;
  if bname is null then raise exception 'Select your bank.'; end if;
  if acct !~ '^[0-9]{10}$' then raise exception 'Enter your 10-digit account number.'; end if;
  if aname is null then raise exception 'Enter the account holder name.'; end if;
  -- Withdrawals are always paid through the gateway's bank list: a valid
  -- 8-digit Afrstar bank code is required (free-text "other bank" removed).
  if bcode is null or bcode !~ '^[0-9]{8}$' then raise exception 'Select your bank from the list.'; end if;

  select * into s from public.site_settings where id = 1;
  if found then
    if amt < s.min_withdrawal then
      raise exception 'Minimum withdrawal is ₦%', to_char(s.min_withdrawal,'FM999,999,999,990');
    end if;
    if s.max_withdrawal is not null and s.max_withdrawal > 0 and amt > s.max_withdrawal then
      raise exception 'Maximum withdrawal is ₦%', to_char(s.max_withdrawal,'FM999,999,999,990');
    end if;
    if not (extract(dow from lagos)::int = any(s.withdrawal_days)) or
       (case when s.withdrawal_open_time <= s.withdrawal_close_time
             then t < s.withdrawal_open_time or t > s.withdrawal_close_time + interval '59 seconds'
             else t < s.withdrawal_open_time and t > s.withdrawal_close_time + interval '59 seconds' end) then
      raise exception 'Withdrawals are closed right now';
    end if;
  end if;

  if not exists (select 1 from public.investments where user_id = uid and status = 'active') then
    raise exception 'You need at least one active investment before you can withdraw.';
  end if;

  select * into w from public.wallets where user_id = uid for update;
  if not found then raise exception 'Wallet not found.'; end if;
  if w.available_balance < amt then raise exception 'Insufficient wallet balance.'; end if;

  update public.wallets set available_balance = available_balance - amt, updated_at = now() where user_id = uid;

  insert into public.withdrawals (user_id, amount, charge, bank_name, bank_code, account_number, account_name, status)
  values (uid, amt, round(amt * coalesce(s.withdrawal_fee_pct, 0) / 100, 2), bname, bcode, acct, aname, 'pending')
  returning id into wid;   -- enforce_withdrawal_rules recomputes the same charge for non-admins

  insert into public.transactions (user_id, amount, type, description)
  values (uid, amt, 'withdrawal', 'Withdrawal request to ' || bname || ' (' || acct || ') — pending');

  insert into public.notifications (user_id, title, message)
  values (uid, 'Withdrawal Pending', 'Your request for ₦' || to_char(amt,'FM999,999,999,990.00') || ' is being reviewed.');

  return wid;
end; $$;
