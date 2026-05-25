# Pipzo Mini App Dashboard Update

This update redesigns the Telegram Mini App flow.

## Changes

1. Removed command logs from the Mini App.
2. Added professional dashboard look.
3. Shows Telegram username and profile picture on top right.
4. First screen is License Access:
   - Enter license key
   - Request license key
   - Choose demo / real / demo+real request type
5. After activation, dashboard opens.
6. Dashboard lets user connect MT5 account.
7. After account details are saved, trade manager buttons are shown.
8. Profile picture opens a menu with Logout.
9. Trade manager section is ready for more options later.

## Files to replace

Replace in your Vercel project:

```text
index.html
assets/js/app.js
assets/css/style.css
```

## Optional API addition

If you want "Request License Key" to save requests to Supabase:

1. Run `sql/license_requests.sql` in Supabase.
2. Add the handler code from `api/request-license-handler.txt` into your single `api/[route].js`.
3. Add this route inside the main handler:
   `if (route === 'request_license') return await handleRequestLicense(req, res, supabase);`

If you skip the optional API addition, the request form will show a message asking user to contact admin manually.
