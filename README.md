# Pipzo Cloud Mode Update

This update adds MT5 Account Connection inside the Telegram Mini App.

## What this adds

* New Supabase table: `mt5\_accounts`
* New Mini App section: Connect MT5 Account
* New Vercel API routes:

  * `/api/save\_mt5\_account`
  * `/api/get\_mt5\_account`
  * `/api/worker\_get\_account`
* Updated VM worker:

  * Can fetch MT5 account details from Vercel/Supabase
  * Can login to MT5 using saved login/password/server
  * Can still use `.env` fallback for testing

## Important Security Note

This starter stores MT5 passwords in Supabase. For testing, this is okay.
Before using with real users, add encryption for passwords.

Recommended production upgrade:

* Encrypt MT5 password before storing
* Store encryption key only in Vercel environment variables
* Never show password in admin or logs
* Add delete account access button

## Install

1. Run `sql/cloud\_mode\_update.sql` in Supabase SQL Editor.
2. Add the new API files from `/api` into your Vercel project `/api`.
3. Replace your Mini App `index.html` and `assets/js/app.js` with the updated ones or manually patch the section.
4. Replace your worker with `worker/pipzo\_cloud\_worker.py`.
5. Push to GitHub and redeploy Vercel.

test push

