create extension if not exists pgcrypto;

create table if not exists license_keys (
  id uuid primary key default gen_random_uuid(),
  license_key text not null unique,
  label text,
  telegram_id text,
  telegram_username text,
  mt5_account text,
  allowed_account_type text default 'both' check (allowed_account_type in ('demo','real','both')),
  is_active boolean not null default true,
  valid_from timestamptz not null default now(),
  valid_until timestamptz not null,
  max_accounts int not null default 1,
  created_at timestamptz not null default now()
);

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  telegram_id text not null unique,
  telegram_username text,
  first_name text,
  last_name text,
  license_key text references license_keys(license_key) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login timestamptz
);

create table if not exists ea_commands (
  id uuid primary key default gen_random_uuid(),
  license_key text not null references license_keys(license_key) on delete cascade,
  telegram_id text,
  mt5_account text,
  command text not null,
  params jsonb default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','processing','executed','failed','cancelled')),
  result text,
  created_at timestamptz not null default now(),
  picked_at timestamptz,
  executed_at timestamptz
);

create index if not exists ea_commands_license_status_idx
on ea_commands(license_key, status, created_at);

create table if not exists ea_status (
  id uuid primary key default gen_random_uuid(),
  license_key text not null unique references license_keys(license_key) on delete cascade,
  mt5_account text,
  broker text,
  server_name text,
  account_name text,
  account_type text,
  balance numeric default 0,
  equity numeric default 0,
  margin numeric default 0,
  free_margin numeric default 0,
  floating_profit numeric default 0,
  open_trades int default 0,
  is_online boolean default false,
  last_seen timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists open_trades (
  id uuid primary key default gen_random_uuid(),
  license_key text not null references license_keys(license_key) on delete cascade,
  mt5_account text,
  ticket text not null,
  symbol text,
  trade_type text,
  lot numeric,
  open_price numeric,
  sl numeric,
  tp numeric,
  profit numeric,
  updated_at timestamptz not null default now(),
  unique(license_key, ticket)
);

alter table license_keys enable row level security;
alter table app_users enable row level security;
alter table ea_commands enable row level security;
alter table ea_status enable row level security;
alter table open_trades enable row level security;
