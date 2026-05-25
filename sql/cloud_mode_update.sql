create table if not exists mt5_accounts (
  id uuid primary key default gen_random_uuid(),
  license_key text not null references license_keys(license_key) on delete cascade,
  telegram_id text,
  telegram_username text,
  mt5_login text not null,
  mt5_password text not null,
  mt5_server text not null,
  account_name text,
  broker text,
  is_active boolean not null default true,
  connection_status text default 'pending',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(license_key)
);

alter table mt5_accounts enable row level security;
