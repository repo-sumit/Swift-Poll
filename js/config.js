/**
 * Swift Poll - central configuration.
 *
 * Everything the frontend needs to know lives here:
 *   - Supabase credentials (public anon key is safe to ship)
 *   - The active poll slug
 *   - The question set rendered in the poll
 *
 * To add a question: append an object to QUESTIONS and mirror
 * it in Supabase (either re-run supabase-schema.sql after
 * editing the seed block, or insert directly from the SQL
 * editor). No HTML changes required.
 */

window.SWIFT_POLL_CONFIG = {
  // -------------------------------------------------------
  // Supabase
  // -------------------------------------------------------
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",

  // -------------------------------------------------------
  // Branding
  // -------------------------------------------------------
  BRAND_NAME: "Swift Poll",
  BRAND_LOGO: "https://i.ibb.co/LDdkBqsS/image-4.png",

  // -------------------------------------------------------
  // Poll identity - must match the slug seeded in Supabase
  // -------------------------------------------------------
  POLL_SLUG: "swift-poll-default",
  POLL_TITLE: "Does your learning system...",
  POLL_INTRO: "A quick pulse-check. Answer honestly - it takes under a minute.",

  // -------------------------------------------------------
  // Dashboard access
  // -------------------------------------------------------
  // Empty string = public dashboard. Set a value to require a
  // passcode (stored in localStorage after first entry).
  DASHBOARD_PASSCODE: "",

  // -------------------------------------------------------
  // Shared option set - used by every question below
  // -------------------------------------------------------
  OPTIONS: [
    { text: "Yes",      value: "yes"      },
    { text: "Not Sure", value: "not_sure" },
    { text: "No",       value: "no"       }
  ],

  // -------------------------------------------------------
  // Questions - order matters. Add more objects here to
  // extend the poll. `id` is a stable local identifier; the
  // real UUIDs live in Supabase and are matched by text.
  // -------------------------------------------------------
  QUESTIONS: [
    {
      id: "q1",
      order: 1,
      type: "single_select",
      text: "Knows where each child actually is in their learning - not just which grade they are in"
    },
    {
      id: "q2",
      order: 2,
      type: "single_select",
      text: "Gives every student a different path based on their level - automatically"
    },
    {
      id: "q3",
      order: 3,
      type: "single_select",
      text: "Lets the struggling child start from where they are - without shame, without being singled out"
    },
    {
      id: "q4",
      order: 4,
      type: "single_select",
      text: "Keeps the advanced child challenged and engaged - without waiting for the teacher to notice"
    },
    {
      id: "q5",
      order: 5,
      type: "single_select",
      text: "Adjusts itself as the child improves - harder when they are ready, simpler when they are stuck"
    },
    {
      id: "q6",
      order: 6,
      type: "single_select",
      text: "Assesses students regularly - tracking progress at every step, not just at the end of a term"
    }
  ]
};
