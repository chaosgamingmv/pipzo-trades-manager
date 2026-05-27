-- Pipzo strict Start request fix
-- This prevents the VM master worker from opening every MT5 instance on restart.
-- Run this once in Supabase before starting the updated VM worker.

alter table mt5_accounts
add column if not exists start_request_id text,
add column if not exists claimed_start_request_id text,
add column if not exists claimed_at timestamptz,
add column if not exists started_at timestamptz;

create index if not exists mt5_accounts_strict_start_idx
on mt5_accounts(start_requested, start_request_id, connection_status, is_active);

-- Clear all old/stale start flags created by previous versions.
-- After this, an account opens ONLY after its own Telegram user presses Start again.
update mt5_accounts
set start_requested = false,
    start_request_id = null,
    start_requested_at = null,
    connection_status = case
      when connection_status in ('pending', 'claimed', 'running', 'connected', 'failed') then 'stopped'
      else connection_status
    end,
    assigned_worker_id = null,
    worker_pid = null,
    claimed_at = null,
    last_worker_heartbeat = null,
    updated_at = now()
where is_active = true;
