/**
 * Swift Poll - central configuration.
 *
 * Live poll questions now come from Supabase and are managed
 * from the admin dashboard. This file holds:
 *   - Supabase credentials (publishable anon key)
 *   - Branding (name, logo)
 *   - Poll identity (slug that must match the DB)
 *   - Dashboard passcode (client-side gate)
 *
 * Initial seed questions live in supabase-schema.sql, not here.
 */

window.SWIFT_POLL_CONFIG = {
  // Supabase
  SUPABASE_URL: "https://bvrvlpokcdcxmaoxqtgs.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_VE-wVyIHXiDYO2zIf2ogqA_72BHW7nR",

  // Branding
  BRAND_NAME: "Swift Poll",
  BRAND_LOGO: "https://i.ibb.co/LDdkBqsS/image-4.png",

  // Poll identity - must match the slug seeded in Supabase
  POLL_SLUG: "swift-poll-default",
  POLL_TITLE: "Does your learning system...",
  POLL_INTRO: "Answer a few quick questions. Takes less than a minute.",

  // Dashboard access - empty to make dashboard public
  DASHBOARD_PASSCODE: "1234"
};
