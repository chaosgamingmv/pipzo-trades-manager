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

create unique index if not exists license_requests_one_pending_per_telegram
on license_requests(telegram_id)
where status = 'pending';

create index if not exists license_requests_status_created_idx
on license_requests(status, created_at desc);

alter table license_requests enable row level security;
