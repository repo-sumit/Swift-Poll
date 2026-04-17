/**
 * Swift Poll - central configuration.
 *
 * Dashboard accounts and poll users now live in Supabase and are
 * managed from the admin dashboard. This file keeps:
 *   - Supabase credentials (publishable anon key)
 *   - Branding
 *   - Poll identity (slug)
 */

window.SWIFT_POLL_CONFIG = {
  SUPABASE_URL: "https://bvrvlpokcdcxmaoxqtgs.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_VE-wVyIHXiDYO2zIf2ogqA_72BHW7nR",

  BRAND_NAME: "Swift Poll",
  BRAND_LOGO: "https://i.ibb.co/LDdkBqsS/image-4.png",

  POLL_SLUG: "swift-poll-default",
  POLL_TITLE: "Does your learning system...",
  POLL_INTRO: "Answer a few quick questions. Takes less than a minute."
};
