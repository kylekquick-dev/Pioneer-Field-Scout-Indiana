# Deploying Pioneer® Field Scout: Indiana to GitHub Pages

This app is 100% static files, so GitHub Pages hosts it for free over HTTPS
(required for the PWA service worker, camera, and magic-link auth).

## File structure (keep all files in the repo ROOT)
```
your-repo/
├─ index.html
├─ app.js
├─ offline.js
├─ sw.js
├─ config.js          <-- edit with your Supabase URL + anon key
├─ manifest.json
├─ schema.sql         (run once in Supabase; not served to users)
├─ README.md
├─ icon-192.png
├─ icon-512.png
├─ favicon.ico
├─ favicon-32.png
├─ apple-touch-icon.png
├─ splash-iphone.png
├─ splash-iphone-std.png
└─ splash-ipad.png
```

## Steps
1. Create a new GitHub repo (e.g. `field-scout-indiana`).
2. Upload all the files above to the repo root (drag-and-drop in the GitHub UI,
   or `git add . && git commit -m "init" && git push`).
3. Repo **Settings → Pages**:
   - Source: **Deploy from a branch**
   - Branch: **main** / folder: **/ (root)** → Save.
4. Wait ~1 minute. Your app is live at:
   `https://<your-username>.github.io/field-scout-indiana/`

## IMPORTANT — paths are relative, so it just works
All asset/script references use relative paths (`app.js`, `sw.js`, `icon-192.png`,
`./index.html`), so the app runs correctly from a project subpath like
`/field-scout-indiana/`. No base-href changes needed.

## After deploying: point Supabase at your URL
In the Supabase dashboard → **Authentication → URL Configuration**:
- **Site URL:** `https://<your-username>.github.io/field-scout-indiana/`
- **Redirect URLs:** add the same URL (so magic links redirect back correctly).

## Updating later
Push new commits; GitHub Pages redeploys automatically. Because the service
worker caches the shell, users get the update on their next visit (the SW
activates and clears the old cache via the `activate` handler in `sw.js`).
Bump `CACHE = "fieldscout-shell-vN"` in `sw.js` when you want to force-refresh
all cached assets.

## Custom domain (optional)
Settings → Pages → Custom domain. Add a `CNAME` DNS record to
`<your-username>.github.io`. HTTPS is provisioned automatically.
