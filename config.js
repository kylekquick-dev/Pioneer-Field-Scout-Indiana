// =====================================================================
// Field Scout — Cloud configuration
// ---------------------------------------------------------------------
// Fill these in from your Supabase project:
//   Supabase Dashboard → Project Settings → API
//     • Project URL      -> SUPABASE_URL
//     • anon public key  -> SUPABASE_ANON_KEY   (safe to ship in the browser;
//                            Row Level Security enforces all permissions)
//
// The admin login email below is the account that will be promoted to
// 'admin' in the database (see step 7 of schema.sql). Viewers do NOT need
// a password — they sign in with a magic link sent to their email.
// =====================================================================

window.FIELD_SCOUT_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-ref.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",

  // Bucket created by schema.sql
  PHOTO_BUCKET: "field-photos",

  // Cosmetic only — the real admin role is enforced server-side via RLS.
  ADMIN_EMAIL: "kyle.quick@yourcompany.com",
  ADMIN_DISPLAY_NAME: "Kyle Quick",
};
