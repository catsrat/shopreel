-- ShopReel — complete database setup. Safe to run multiple times.
-- Paste the whole thing into Supabase → SQL Editor → Run.

-- ========== TABLES ==========
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  handle text unique not null,
  email text,
  vertical text default 'beauty',
  plan text,
  plan_since timestamptz,
  stripe_customer_id text,
  links jsonb default '[]'::jsonb,
  avatar_url text,
  created_at timestamptz default now()
);
alter table profiles add column if not exists avatar_url text;
alter table profiles add column if not exists links jsonb default '[]'::jsonb;
alter table profiles add column if not exists plan text;
alter table profiles add column if not exists plan_since timestamptz;
alter table profiles add column if not exists stripe_customer_id text;

create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid references profiles(id) on delete cascade,
  handle text not null,
  vertical text default 'beauty',
  caption text,
  video_url text not null,
  poster_url text,
  views int default 0,
  watch_ms bigint default 0,
  shares int default 0,
  created_at timestamptz default now()
);
alter table posts add column if not exists shares int default 0;
alter table posts add column if not exists poster_url text;

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

create table if not exists likes (
  user_id uuid references profiles(id) on delete cascade,
  post_id uuid references posts(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, post_id)
);

create table if not exists saves (
  user_id uuid references profiles(id) on delete cascade,
  post_id uuid references posts(id) on delete cascade,
  created_at timestamptz default now(),
  primary key (user_id, post_id)
);

create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references posts(id) on delete cascade,
  user_id uuid references profiles(id) on delete cascade,
  handle text not null,
  text text not null,
  created_at timestamptz default now()
);

create table if not exists creator_earnings (
  creator_id uuid primary key references profiles(id) on delete cascade,
  clicks int default 0,
  sales int default 0,
  pending numeric default 0,
  confirmed numeric default 0,
  paid_out numeric default 0,
  currency text default 'EUR',
  updated_at timestamptz default now()
);
alter table creator_earnings add column if not exists paid_out numeric default 0;

create table if not exists payout_accounts (
  user_id uuid primary key references profiles(id) on delete cascade,
  paypal_email text,
  upi text,
  country text,
  updated_at timestamptz default now()
);

-- ========== ROW LEVEL SECURITY ==========
alter table profiles enable row level security;
alter table posts    enable row level security;
alter table products enable row level security;
alter table likes    enable row level security;
alter table saves    enable row level security;
alter table comments enable row level security;
alter table creator_earnings enable row level security;
drop policy if exists "earnings read own" on creator_earnings;
create policy "earnings read own" on creator_earnings for select using (auth.uid() = creator_id);
alter table payout_accounts enable row level security;
drop policy if exists "payout self" on payout_accounts;
create policy "payout self" on payout_accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "profiles read"       on profiles;
drop policy if exists "profiles insert own" on profiles;
drop policy if exists "profiles update own" on profiles;
create policy "profiles read"       on profiles for select using (true);
create policy "profiles insert own" on profiles for insert with check (auth.uid() = id);
create policy "profiles update own" on profiles for update using (auth.uid() = id);

drop policy if exists "posts read"       on posts;
drop policy if exists "posts insert own" on posts;
drop policy if exists "posts update own" on posts;
drop policy if exists "posts delete own" on posts;
create policy "posts read"       on posts for select using (true);
create policy "posts insert own" on posts for insert with check (auth.uid() = creator_id);
create policy "posts update own" on posts for update using (auth.uid() = creator_id);
create policy "posts delete own" on posts for delete using (auth.uid() = creator_id);

drop policy if exists "products read"       on products;
drop policy if exists "products insert own" on products;
drop policy if exists "products update own" on products;
create policy "products read"       on products for select using (true);
create policy "products insert own" on products for insert with check (
  exists (select 1 from posts where posts.id = products.post_id and posts.creator_id = auth.uid()));
create policy "products update own" on products for update using (
  exists (select 1 from posts where posts.id = products.post_id and posts.creator_id = auth.uid()));

drop policy if exists "likes read"       on likes;
drop policy if exists "likes insert own" on likes;
drop policy if exists "likes delete own" on likes;
create policy "likes read"       on likes for select using (true);
create policy "likes insert own" on likes for insert with check (auth.uid() = user_id);
create policy "likes delete own" on likes for delete using (auth.uid() = user_id);

drop policy if exists "saves read"       on saves;
drop policy if exists "saves insert own" on saves;
drop policy if exists "saves delete own" on saves;
create policy "saves read"       on saves for select using (true);
create policy "saves insert own" on saves for insert with check (auth.uid() = user_id);
create policy "saves delete own" on saves for delete using (auth.uid() = user_id);

drop policy if exists "comments read"       on comments;
drop policy if exists "comments insert own" on comments;
drop policy if exists "comments delete own" on comments;
create policy "comments read"       on comments for select using (true);
create policy "comments insert own" on comments for insert with check (auth.uid() = user_id);
create policy "comments delete own" on comments for delete using (auth.uid() = user_id);

-- ========== STATS COUNTER FUNCTIONS ==========
create or replace function increment_view(p_post uuid) returns void
  language sql security definer as $$ update posts set views = views + 1 where id = p_post; $$;
create or replace function add_watch(p_post uuid, p_ms bigint) returns void
  language sql security definer as $$ update posts set watch_ms = watch_ms + p_ms where id = p_post; $$;
create or replace function increment_tap(p_product uuid) returns void
  language sql security definer as $$ update products set clicks = clicks + 1 where id = p_product; $$;
create or replace function increment_share(p_post uuid) returns void
  language sql security definer as $$ update posts set shares = shares + 1 where id = p_post; $$;

-- ========== STORAGE (videos + avatars use the 'videos' bucket) ==========
drop policy if exists "videos public read"          on storage.objects;
drop policy if exists "videos authenticated upload" on storage.objects;
create policy "videos public read"
  on storage.objects for select using (bucket_id = 'videos');
create policy "videos authenticated upload"
  on storage.objects for insert to authenticated with check (bucket_id = 'videos');
