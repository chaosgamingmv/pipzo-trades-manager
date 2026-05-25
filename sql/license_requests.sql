create table if not exists license_requests (
  id uuid primary key default gen_random_uuid(),
  telegram_id text,
  telegram_username text,
  first_name text,
  request_type text not null default 'both' check (request_type in ('demo','real','both')),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table license_requests enable row level security;
