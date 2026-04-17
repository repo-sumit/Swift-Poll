# Swift Poll

A lightweight, mobile-first polling web app. One question per screen, responses saved to Supabase, aggregated dashboard with user-wise breakdown. Static HTML/CSS/Vanilla JS. Deployable to Vercel on the free tier.

![Swift Poll](https://i.ibb.co/LDdkBqsS/image-4.png)

---

## 1. Project overview

- Three pages: landing (`index.html`), poll flow (`poll.html`), dashboard (`dashboard.html`).
- No build step. No framework. Only runtime dependency is `@supabase/supabase-js` via CDN.
- Questions driven from [`js/config.js`](js/config.js) so you can add more without touching HTML.
- Schema + seed in [`supabase-schema.sql`](supabase-schema.sql). Indexed, RLS-enabled, ready for anon inserts.

---

## 2. Local setup

Requires only a static file server (any will do):

```bash
# option A - python (ships with most systems)
cd "Swift Poll"
python -m http.server 5173

# option B - node
npx serve .

# option C - VS Code "Live Server" extension
```

Open `http://localhost:5173/`.

> Opening the `.html` files with `file://` will fail - Supabase auth checks and some browser APIs require `http(s)`.

---

## 3. Supabase project setup

1. Sign up at [supabase.com](https://supabase.com) and create a new project (free tier is fine; choose Mumbai/Singapore region for Indian users).
2. From **Project Settings -> API**, copy:
   - Project URL
   - `anon` public key
3. Open **SQL Editor -> New query**, paste the entire contents of [`supabase-schema.sql`](supabase-schema.sql), and run it. This creates:
   - `users`, `polls`, `questions`, `question_options`, `submissions`, `answers`
   - Indexes, RLS policies, and the default poll seed (`swift-poll-default`) with all six questions.

The script is idempotent - rerunning it will not duplicate data.

---

## 4. Environment variable setup

This is a pure static frontend, so values live in [`js/config.js`](js/config.js). Open it and replace:

```js
SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
```

with your own values from step 3. The anon key is safe to ship because RLS constrains what it can do.

If you prefer to manage credentials via `.env`:

- Copy `.env.example` to `.env` (kept local, not served).
- At deploy time, inject the values into `config.js` using whatever automation you like (Vercel env vars + a `vercel-build` script, GitHub Actions, etc.). The simplest thing is to edit `config.js` directly.

Optional settings in `config.js`:

- `POLL_SLUG` - must match the slug in Supabase.
- `DASHBOARD_PASSCODE` - set a value to require a passcode before the dashboard loads.

---

## 5. Local run instructions

1. Start any static server in the project root.
2. Visit `/` to see the landing page.
3. Click **Start Poll**, enter your name, answer the six questions.
4. After submit, open `/dashboard.html` to see aggregates and individual responses.

If something fails with "App is not configured yet", you missed step 4.

---

## 6. Vercel deployment

Option A - CLI:

```bash
npm i -g vercel
vercel            # first time: link / create project
vercel --prod
```

Option B - GitHub:

1. Push this folder to a new GitHub repo.
2. On [vercel.com/new](https://vercel.com/new), import the repo.
3. Framework preset: **Other**. Build command: *(blank)*. Output directory: *(blank)*.
4. Deploy.

`vercel.json` in the project root adds sensible security headers and short-cache for `css/` and `js/`.

**Edit credentials**: before deploying, either hard-code them in `js/config.js` or set them up via a tiny build script. Vercel env vars do not auto-populate static JS; for a zero-tool deploy, just edit `config.js`.

---

## 7. How dashboard works

- **Aggregated counts**: one query fetches all `answers` for the active poll, then counts are tallied client-side. Questions and options come from a cached poll graph so empty options still render with 0.
- **User-wise responses**: a single joined query pulls each submission with its user and answers. Mobile renders stacked cards; desktop renders a sticky-headed table.
- **Refresh** re-runs all queries. **Export CSV** dumps the currently loaded submissions as a downloadable CSV (purely client-side).

Loading, error, and empty states are all handled.

---

## 8. How to add more questions

1. Open [`js/config.js`](js/config.js) and append a new object to `QUESTIONS`:

   ```js
   {
     id: "q7",
     order: 7,
     type: "single_select",
     text: "Your new question text"
   }
   ```

2. In Supabase (SQL Editor), insert the question + options:

   ```sql
   with p as (select id from polls where slug = 'swift-poll-default'),
        q as (
          insert into questions (poll_id, question_text, question_type, display_order)
          select id, 'Your new question text', 'single_select', 7 from p
          returning id
        )
   insert into question_options (question_id, option_text, option_value, display_order)
   select id, 'Yes',      'yes',      1 from q union all
   select id, 'Not Sure', 'not_sure', 2 from q union all
   select id, 'No',       'no',       3 from q;
   ```

   Or re-edit the seed block at the bottom of `supabase-schema.sql` and rerun it.

3. Refresh the app. No HTML/CSS changes needed.

The option set (`OPTIONS`) is shared. If you want per-question options, extend the `QUESTIONS` entry with its own `options` array and update `poll.js` accordingly.

---

## 9. Security

- RLS is enabled on every table. Anon users can:
  - `select` everything (needed to render the poll and the dashboard)
  - `insert` into `users`, `submissions`, `answers` (needed to submit)
- Anon users cannot `update` or `delete` anything.
- The dashboard is public by default. Set `DASHBOARD_PASSCODE` in `config.js` to gate it with a simple client-side passcode (good enough for internal sharing, not a substitute for proper auth).

For a stricter production setup, consider:

1. **Private dashboard via Supabase auth** - add email/magic-link login, restrict `select` on `submissions`/`answers`/`users` to authenticated admins via RLS.
2. **Aggregated-only dashboard** - move user-wise queries into a Postgres `security definer` function and deny direct select on `users`/`answers`.
3. **Rate limiting** - add a Supabase Edge Function that inserts submissions after validating a Turnstile/hCaptcha token.

---

## 10. Known limitations / future enhancements

- Single poll per deployment (via `POLL_SLUG`). Multi-poll routing would need a small tweak in the URL handling.
- No auth - duplicates can be prevented client-side (draft in `localStorage`, disabled buttons while submitting), but determined users can submit twice.
- Dashboard tallies client-side - fine for thousands of submissions, swap to a SQL `group by` once you cross that.
- Aggregated view `v_question_option_counts` is created by the schema but currently unused by the frontend. Easy hook if you want to move counts to the server.

---

## Folder layout

```
swift-poll/
  index.html
  poll.html
  dashboard.html
  vercel.json
  .env.example
  supabase-schema.sql
  README.md
  css/
    styles.css
  js/
    config.js
    utils.js
    supabase.js
    main.js
    poll.js
    dashboard.js
  assets/
```
