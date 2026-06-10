-- ShopReel database schema
-- Run this in your Supabase project: SQL Editor → New query → paste → Run.

-- ---------- PROFILES (one row per user) ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text unique not null,
  email text,
  vertical text default 'beauty',
  plan text,                          -- 'starter' | 'pro' | 'business' | null
  plan_since timestamptz,
  stripe_customer_id text,
  links jsonb default '[]'::jsonb,
  created_at timestamptz default now()
);

-- ---------- POSTS (videos) ----------
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references profiles(id) on delete cascade,
  handle text not null,
  vertical text default 'beauty',
  caption text,
  video_url text not null,
  views int default 0,
  watch_ms bigint default 0,
  created_at timestamptz default now()
);

-- ---------- PRODUCTS (affiliate links on a video) ----------
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references posts(id) on delete cascade,
  title text not null,
  price numeric default 0,
  image text,
  link text not null,
  clicks int default 0,
  position int default 0
);

-- ---------- Row Level Security ----------
alter table profiles enable row level security;
alter table posts enable row level security;
alter table products enable row level security;

create policy "profiles read"        on profiles for select using (true);
create policy "profiles insert own"  on profiles for insert with check (auth.uid() = id);
create policy "profiles update own"  on profiles for update using (auth.uid() = id);

create policy "posts read"           on posts for select using (true);
create policy "posts insert own"     on posts for insert with check (auth.uid() = creator_id);
create policy "posts update own"     on posts for update using (auth.uid() = creator_id);
create policy "posts delete own"     on posts for delete using (auth.uid() = creator_id);

create policy "products read"        on products for select using (true);
create policy "products insert own"  on products for insert with check (
  exists (select 1 from posts where posts.id = products.post_id and posts.creator_id = auth.uid()));
create policy "products update own"  on products for update using (
  exists (select 1 from posts where posts.id = products.post_id and posts.creator_id = auth.uid()));

-- ---------- Counter functions (any viewer can safely bump stats) ----------
create or replace function increment_view(p_post uuid) returns void
  language sql security definer as $$ update posts set views = views + 1 where id = p_post; $$;

create or replace function add_watch(p_post uuid, p_ms bigint) returns void
  language sql security definer as $$ update posts set watch_ms = watch_ms + p_ms where id = p_post; $$;

create or replace function increment_tap(p_product uuid) returns void
  language sql security definer as $$ update products set clicks = clicks + 1 where id = p_product; $$;
