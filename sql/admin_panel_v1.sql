-- Pipzo Admin Panel v1 helper migration
-- Run this after your existing Pipzo SQL files if any of these columns are missing.

alter table mt5_accounts
  add column if not exists assigned_worker_id text,
  add column if not exists assigned_terminal_dir text,
  add column if not exists worker_pid int,
  add column if not exists last_worker_heartbeat timestamptz,
  add column if not exists start_requested boolean not null default false,
  add column if not exists start_requested_at timestamptz,
  add column if not exists start_request_id text,
  add column if not exists claimed_start_request_id text,
  add column if not exists claimed_at timestamptz,
  add column if not exists started_at timestamptz;

alter table ea_status
  add column if not exists algo_trading_allowed boolean,
  add column if not exists account_trade_allowed boolean;

create index if not exists mt5_accounts_admin_status_idx
on mt5_accounts(is_active, connection_status, updated_at desc);

create index if not exists ea_commands_admin_status_idx
on ea_commands(status, created_at desc);

create index if not exists license_keys_admin_status_idx
on license_keys(is_active, valid_until desc);
