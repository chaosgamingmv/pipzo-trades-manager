# Pipzo Mini App UI Fixed

This fixes:
- Better professional dark UI
- Request License Key button visible and working
- After license activation, app correctly moves to dashboard
- Cleaner dashboard layout
- Profile dropdown with logout
- MT5 account step shown before trade manager
- Removed command logs section

Replace these files in your Vercel project:

```text
index.html
assets/css/style.css
assets/js/app.js
```

Then push:

```bash
git add .
git commit -m "Fix mini app UI and activation flow"
git push
```

Optional request license API:
- If `/api/request_license` is not added yet, the button will show a fallback message asking user to contact admin.
