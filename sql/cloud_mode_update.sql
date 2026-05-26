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
  updated_at timestamptz not null default now()
);

alter table mt5_accounts enable row level security;


-- Multi-account command fix
alter table mt5_accounts
  drop constraint if exists mt5_accounts_license_key_key;

create unique index if not exists mt5_accounts_one_login_per_user_server
on mt5_accounts(telegram_id, mt5_login, mt5_server);

alter table ea_commands
  add column if not exists mt5_account text;

create index if not exists ea_commands_license_mt5_status_idx
on ea_commands(license_key, mt5_account, status, created_at);

alter table ea_status
  drop constraint if exists ea_status_license_key_key;

create unique index if not exists ea_status_one_row_per_license_account
on ea_status(license_key, mt5_account);
