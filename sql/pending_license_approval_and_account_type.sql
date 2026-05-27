-- Pipzo pending license approval + account-type enforcement
-- Run this in Supabase before deploying the updated API/Admin Panel.

create extension if not exists pgcrypto;

create table if not exists license_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_id text,
  telegram_username text,
  first_name text,
  last_name text,
  request_type text not null default 'both' check (request_type in ('demo','real','both')),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  note text,
  admin_note text,
  license_key text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table license_requests
  add column if not exists last_name text,
  add column if not exists admin_note text,
  add column if not exists license_key text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now();

-- Keep only one pending request per Telegram user.
create unique index if not exists license_requests_one_pending_per_telegram
on license_requests(telegram_id)
where status = 'pending';

create index if not exists license_requests_status_created_idx
on license_requests(status, created_at desc);

-- License types:
-- demo = only MT5 server names containing "trial"
-- real = only MT5 server names containing "real"
-- both = can use both demo and real accounts
alter table license_keys
  add column if not exists allowed_account_type text default 'both';

-- Make sure old null values behave as Demo + Real.
update license_keys
set allowed_account_type = 'both'
where allowed_account_type is null;
