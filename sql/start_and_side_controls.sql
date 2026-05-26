-- Pipzo start button + side-specific controls migration
-- Run this once in Supabase SQL editor before testing the updated VM worker.

alter table mt5_accounts
add column if not exists start_requested boolean not null default false,
add column if not exists start_requested_at timestamptz,
add column if not exists started_at timestamptz;

create index if not exists mt5_accounts_start_requested_idx
on mt5_accounts(start_requested, is_active, connection_status);

-- Optional: reset existing accounts so MT5 does not auto-open until user presses Start.
-- Uncomment only if you want all old accounts to require pressing Start again.
-- update mt5_accounts
-- set start_requested = false,
--     start_requested_at = null,
--     connection_status = 'pending',
--     assigned_worker_id = null,
--     assigned_terminal_dir = null,
--     worker_pid = null,
--     claimed_at = null,
--     last_worker_heartbeat = null
-- where is_active = true;
