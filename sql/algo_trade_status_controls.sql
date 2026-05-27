-- Adds Algo Trading status fields shown in the Mini App.
-- Run this once in Supabase before deploying the updated worker.

alter table ea_status
  add column if not exists algo_trading_allowed boolean,
  add column if not exists account_trade_allowed boolean;

create index if not exists ea_status_algo_updated_idx
on ea_status(license_key, mt5_account, updated_at desc);
