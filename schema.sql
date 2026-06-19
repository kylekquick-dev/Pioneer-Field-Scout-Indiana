-- =====================================================================
-- Field Scout — Cloud backend schema (Supabase / Postgres)
-- Run this in: Supabase Dashboard → SQL Editor → New query → Run
-- =====================================================================

-- ---------- 1. PROFILES (role per user) -----------------------------
-- Mirrors auth.users; stores the app role. Default new sign-ups = viewer.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'viewer' check (role in ('admin','viewer')),
  created_at  timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user is created.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    'viewer'                       -- everyone starts as a read-only viewer
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Helper: is the current request made by an admin?
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------- 2. OBSERVATIONS ----------------------------------------
create table if not exists public.observations (
  id            uuid primary key default gen_random_uuid(),
  category      text not null check (category in
                 ('disease','insect','nutrient','herbicide','environmental')),
  title         text not null,
  severity      text,
  field         text,
  crop          text,
  product       text,
  planting_date date,
  growth_stage  text,
  scouting_date date,
  scout         text,
  gps_lat       double precision,
  gps_lng       double precision,
  weather       text,
  gdd           numeric,
  rain_7d       text,
  notes         text,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists observations_category_idx on public.observations(category);
create index if not exists observations_created_idx   on public.observations(created_at desc);

-- keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists observations_touch on public.observations;
create trigger observations_touch
  before update on public.observations
  for each row execute function public.touch_updated_at();

-- ---------- 3. PHOTOS (metadata; binaries live in Storage) ----------
create table if not exists public.photos (
  id             uuid primary key default gen_random_uuid(),
  observation_id uuid not null references public.observations(id) on delete cascade,
  storage_path   text not null,          -- full-size image path in 'field-photos'
  thumb_path     text,                    -- 320px thumbnail path (fast card loading)
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists photos_obs_idx on public.photos(observation_id);
-- For databases created before thumbnails were added:
alter table public.photos add column if not exists thumb_path text;

-- ---------- OPEN SIGN-UPS ----------
-- Open sign-ups are ON by default in Supabase: anyone can request a magic
-- link and a 'viewer' profile is auto-created (handle_new_user trigger).
-- To keep it open, ensure Dashboard -> Authentication -> Sign In / Providers
-- -> Email is enabled and "Allow new users to sign up" is left ON.
-- (Set it OFF only if you later want invite-only access.)

-- =====================================================================
-- 4. ROW LEVEL SECURITY
--    Viewers: read everything. Admins: read + write everything.
-- =====================================================================
alter table public.profiles     enable row level security;
alter table public.observations enable row level security;
alter table public.photos       enable row level security;

-- PROFILES: a user can read their own profile; admins can read all.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using ( id = auth.uid() or public.is_admin() );

-- Only admins may change roles / profiles (besides the auto-insert trigger).
drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles
  for update using ( public.is_admin() ) with check ( public.is_admin() );

-- OBSERVATIONS: any authenticated user can read.
drop policy if exists obs_select on public.observations;
create policy obs_select on public.observations
  for select using ( auth.role() = 'authenticated' );

-- Only admins can insert / update / delete.
drop policy if exists obs_insert on public.observations;
create policy obs_insert on public.observations
  for insert with check ( public.is_admin() );

drop policy if exists obs_update on public.observations;
create policy obs_update on public.observations
  for update using ( public.is_admin() ) with check ( public.is_admin() );

drop policy if exists obs_delete on public.observations;
create policy obs_delete on public.observations
  for delete using ( public.is_admin() );

-- PHOTOS: same pattern.
drop policy if exists photos_select on public.photos;
create policy photos_select on public.photos
  for select using ( auth.role() = 'authenticated' );

drop policy if exists photos_write on public.photos;
create policy photos_write on public.photos
  for all using ( public.is_admin() ) with check ( public.is_admin() );

-- =====================================================================
-- 5. STORAGE BUCKET for photos
--    Create a PRIVATE bucket named 'field-photos' in the dashboard,
--    OR run the insert below, then apply these storage policies.
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('field-photos', 'field-photos', false)
on conflict (id) do nothing;

-- Authenticated users may VIEW photo objects.
drop policy if exists "field-photos read" on storage.objects;
create policy "field-photos read" on storage.objects
  for select using (
    bucket_id = 'field-photos' and auth.role() = 'authenticated'
  );

-- Only admins may UPLOAD / UPDATE / DELETE photo objects.
drop policy if exists "field-photos admin write" on storage.objects;
create policy "field-photos admin write" on storage.objects
  for all using (
    bucket_id = 'field-photos' and public.is_admin()
  ) with check (
    bucket_id = 'field-photos' and public.is_admin()
  );

-- =====================================================================
-- 6. REALTIME — broadcast changes so all devices stay in sync.
-- =====================================================================
alter publication supabase_realtime add table public.observations;
alter publication supabase_realtime add table public.photos;

-- =====================================================================
-- 7. PROMOTE KYLE TO ADMIN
--    Run AFTER Kyle has signed in once (so his auth.users row exists).
--    Replace the email if needed.
-- =====================================================================
-- update public.profiles
--   set role = 'admin', full_name = 'Kyle Quick'
--   where email = 'kyle.quick@yourcompany.com';