# Pioneer® Field Scout: Indiana — Cloud (multi-device, team-synced)

A cloud version of the Pioneer® Field Scout: Indiana crop-scouting & agronomic-training app.
Data syncs across devices and team members in real time, photos are stored in
cloud object storage, the administrator (Kyle Quick) has full edit rights, and
**viewers sign in passwordlessly via an emailed magic link**.

## Files
| File | Purpose |
|------|---------|
| `index.html` | The app shell (UI, tabs, modals). Load this in the browser. |
| `app.js` | All logic: Supabase auth, CRUD, realtime sync, cloud photos, map, PDF, offline sync. |
| `offline.js` | IndexedDB write-queue + client-side thumbnail/image downscaling. |
| `sw.js` | Service worker — caches the app shell + libraries for offline use. |
| `manifest.json` | PWA manifest (installable app, icons, theme). |
| `config.js` | Your Supabase URL + anon key + admin email. **Edit this.** |
| `schema.sql` | Database tables, roles, Row-Level Security, storage bucket, realtime. |
| `icon-192.png`, `icon-512.png` | PWA app icons (plant + DNA + chemistry + data theme). |
| `favicon.ico`, `favicon-32.png` | Browser tab favicons. |
| `apple-touch-icon.png` | iOS home-screen icon (180px). |
| `splash-iphone.png`, `splash-iphone-std.png`, `splash-ipad.png` | iOS PWA launch splash screens. |
## Architecture
```
Browsers (admin + viewers)
        │  HTTPS
        ▼
Supabase: Auth ─ Postgres (RLS) ─ Storage (field-photos) ─ Realtime
```
- **Auth** — admin uses email+password; viewers use passwordless magic links.
- **Postgres + RLS** — viewers read everything; only admins can write. Enforced
  on the server, so the rules can't be bypassed from the browser.
- **Storage** — original photos in a private `field-photos` bucket, served via
  short-lived signed URLs.
- **Realtime** — every insert/update/delete is broadcast, so all open devices
  refresh automatically.

---

## Setup (about 15 minutes)

### 1. Create a Supabase project
1. Go to <https://supabase.com> → **New project** (free tier is fine).
2. Wait for it to provision.

### 2. Run the schema
1. Dashboard → **SQL Editor** → **New query**.
2. Paste the entire contents of `schema.sql` → **Run**.
   This creates the tables, RLS policies, the private `field-photos` bucket,
   the realtime publication, and the auto-profile trigger.

### 3. Configure email (magic links)
- Magic links work out of the box on Supabase's built-in email for testing.
- For production/volume, set up a custom SMTP provider:
  Dashboard → **Authentication → Providers / SMTP settings**.
- Make sure **Authentication → URL Configuration → Site URL** (and Redirect URLs)
  includes wherever you host the app (e.g. `https://yourname.github.io/fieldscout/`
  or `http://localhost:5173`). The magic link redirects back here.

### 4. Fill in `config.js`
From Dashboard → **Project Settings → API**:
```js
SUPABASE_URL:      "https://abcdxyz.supabase.co",
SUPABASE_ANON_KEY: "eyJhbGciOi....",   // the anon public key
ADMIN_EMAIL:       "kyle.quick@yourcompany.com",
ADMIN_DISPLAY_NAME:"Kyle Quick",
```
> The anon key is safe to ship in the browser — RLS is what protects your data.

### 5. Create the admin account (Kyle)
1. Dashboard → **Authentication → Users → Add user**.
2. Email = Kyle's email, set a password (this is the admin password), and tick
   **Auto Confirm User**.
3. Promote him to admin — SQL Editor:
   ```sql
   update public.profiles
     set role = 'admin', full_name = 'Kyle Quick'
     where email = 'kyle.quick@yourcompany.com';
   ```

### 6. Host the app
Any static host works (all files must sit together in one folder):
- **Quick local test:** `python3 -m http.server 5173` then open
  <http://localhost:5173>. (Use a server, not `file://`, so config/app load.)
- **Production:** GitHub Pages, Netlify, Vercel, S3+CloudFront, or an internal
  web server. Upload `index.html`, `app.js`, `config.js` together.

---

## Using it
- **Administrator:** Sign In → **Administrator** tab → email + password →
  full add / edit / delete. Photos upload to the cloud automatically.
- **Viewers (no password):** Sign In → **Viewer** tab → enter email →
  **Send Magic Link** → click the link in the email → read-only access to the
  whole training library, the map, and PDF handout export.
- **Add a new viewer:** they just request a magic link with their email. A
  `viewer` profile is created automatically on first sign-in. (To require
  invite-only access, disable open sign-ups in Auth settings and pre-add users.)
- **Realtime:** the "Live sync" indicator turns green; changes from any device
  appear everywhere within a second or two.

## Offline PWA (works in the field)
The app is an installable Progressive Web App:
- **Install it:** open the hosted URL on a phone/tablet → browser menu →
  *Add to Home Screen / Install*. It then launches full-screen like a native app.
- **App shell cached:** `sw.js` caches `index.html`, `app.js`, `offline.js`,
  `config.js`, the CDN libraries, and visited map tiles, so the app opens with
  no signal.
- **Capture offline:** when the device is offline, a new observation (including
  its photos) is saved to **IndexedDB**. The header shows 🔴 Offline and an
  “⏳ N pending” badge.
- **Auto-sync:** when the connection returns (or you tap the pending badge),
  queued observations and photos upload automatically and the badge clears.
- **Note:** *editing* an existing observation requires a connection; only
  *new* captures are queued offline. Admin must be signed in for the queue to sync.
- **Icons:** add `icon-192.png` and `icon-512.png` (any square PNGs / your logo)
  next to the other files so the installed app and home-screen icon look right.

## Thumbnails (fast loading)
Photos are processed in the browser at upload time:
- A **320px JPEG thumbnail** is generated and used on cards and in galleries.
- The full image is **downscaled to a 1600px cap (~82% JPEG)** to save storage
  and bandwidth; tapping a photo still opens this larger version.
- Both are stored in the `field-photos` bucket; the `photos.thumb_path` column
  (added by `schema.sql`) tracks the thumbnail. No server-side function needed.

## Open sign-ups
Open sign-ups are **enabled by default** in Supabase:
- Anyone can request a magic link; a read-only `viewer` profile is created
  automatically on first sign-in.
- Verify it stays on under **Dashboard → Authentication → Sign In / Providers
  → Email → “Allow new users to sign up.”** Turn it OFF only if you later want
  invite-only access.

## Notes & options
- **Audit trail:** `created_by`, `created_at`, `updated_at` are already tracked.
- **Security:** never paste the **service_role** key into the browser — only the
  **anon** key belongs in `config.js`.