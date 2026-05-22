# Pipzo Trade Manager - Vercel Node.js Version

This version uses only:

- Vercel frontend
- Vercel Node.js API routes
- Supabase PostgreSQL
- MQL5 EA

No PHP hosting needed.

## 1. Run Supabase SQL

Open Supabase SQL Editor and run:

```text
sql/schema.sql
```

## 2. Add Vercel Environment Variables

In Vercel:

```text
Project → Settings → Environment Variables
```

Add:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
TELEGRAM_BOT_TOKEN
EA_API_SECRET
ADMIN_PASSWORD
```

Example:

```text
EA_API_SECRET = pipzo-secret-2026-long-random
ADMIN_PASSWORD = your-admin-password
```

## 3. Deploy to Vercel

Push this project to GitHub. Vercel will install dependencies and deploy.

## 4. URLs

Mini App:

```text
https://pipzo-trades-manager.vercel.app/
```

Admin:

```text
https://pipzo-trades-manager.vercel.app/admin
```

API Base:

```text
https://pipzo-trades-manager.vercel.app/api
```

## 5. Telegram BotFather

Set Telegram Mini App URL to:

```text
https://pipzo-trades-manager.vercel.app/
```

## 6. MT5 EA

Copy:

```text
mt5/PipzoVercelTradeManager.mq5
```

to:

```text
MQL5/Experts/
```

Compile in MetaEditor.

EA inputs:

```text
ApiBaseUrl = https://pipzo-trades-manager.vercel.app/api
LicenseKey = generated license key
EaApiSecret = same as EA_API_SECRET in Vercel
```

MT5 WebRequest allowed URL:

```text
https://pipzo-trades-manager.vercel.app
```

## 7. Test flow

1. Open admin page.
2. Enter admin password.
3. Generate license key.
4. Open Mini App in Telegram.
5. Activate with license key.
6. Attach EA in MT5 with same key.
7. Press Refresh Status in Mini App.
