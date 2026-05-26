-- Pipzo multi-account command fix
-- Run this once in Supabase SQL editor before deploying the updated files.

-- 1) Allow multiple MT5 accounts under one license/Telegram user.
alter table mt5_accounts
  drop constraint if exists mt5_accounts_license_key_key;

create unique index if not exists mt5_accounts_one_login_per_user_server
on mt5_accounts(telegram_id, mt5_login, mt5_server);

-- 2) Make EA/worker commands account-specific.
alter table ea_commands
  add column if not exists mt5_account text;

create index if not exists ea_commands_license_mt5_status_idx
on ea_commands(license_key, mt5_account, status, created_at);

-- 3) Store status per MT5 account instead of only per license.
alter table ea_status
  drop constraint if exists ea_status_license_key_key;

create unique index if not exists ea_status_one_row_per_license_account
on ea_status(license_key, mt5_account);

create index if not exists ea_status_license_account_updated_idx
on ea_status(license_key, mt5_account, updated_at desc);
