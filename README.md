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

## 6b. Roles, accounts, and admin workflows

Swift Poll has two dashboard roles:

- **Admin** - full access: manage questions, manage dashboard users, delete individual responses, export CSV, reset poll data.
- **User** - limited to their own scope: sees only submissions tagged to their account, no admin controls.

### Default seeded credentials

After you run [supabase-schema.sql](supabase-schema.sql) the `dashboard_users` table is seeded with:

| Display name | Role  | Password |
|---|---|---|
| Admin  | admin | `1234` |
| User 1 | user  | `user` |
| User 2 | user  | `user` |
| User 3 | user  | `user` |
| User 4 | user  | `user` |
| User 5 | user  | `user` |
| User 6 | user  | `user` |

Change these immediately in production: log in as Admin -> **Manage users** -> **Password**.

### Admin actions

- **Manage questions**: add MCQ (2-5 options) or text-input questions, mark required/optional, soft-delete.
- **Manage users**: add / rename / change password / deactivate. The DB refuses to deactivate the last active admin.
- **Delete a response**: click Delete on any row in **User-wise responses**. Removes the submission and its answers (cascade).
- **Reset**: opens a modal that first downloads a CSV of every submission, then calls `dashboard_reset_data` which wipes questions, options, submissions, and answers. Polls and dashboard users are kept. Type `RESET` to confirm.

### Security tradeoffs

- Passwords are hashed with **bcrypt** via `pgcrypto.crypt()` inside `security definer` RPCs. Anon clients cannot read `dashboard_users` directly - `password_hash` never leaves the database.
- Admin-only actions (create question, delete submission, reset) rely on RLS that allows anon writes + client-side role gating. A sufficiently determined caller with the anon key can still bypass the UI checks. For true role enforcement, migrate to **Supabase Auth** with role-scoped RLS.
- The dashboard session lives only in `sessionStorage` (one tab lifetime). No remember-me.



Swift Poll ships with a built-in "pick which user you are" dimension so you can split one poll across six audiences without needing proper auth.

- The poll start screen has a required **Select user** dropdown (User 1 through User 6).
- Every submission is tagged with that value in `submissions.assigned_user`.
- The dashboard has a top **View responses for** dropdown that filters totals, aggregates, user-wise rows, and CSV export to just that user (or "All Users").

### Dashboard access flow

1. Click **Dashboard** anywhere -> redirected to `/dashboard-access.html`.
2. Pick a user ("All Users" is allowed) and enter the dashboard password (`DASHBOARD_PASSCODE` in `js/config.js`).
3. On success, the chosen user is stored in `sessionStorage.dashboardUser` and you land on the dashboard filtered to that scope.
4. The top filter can switch scopes at any time. **Log out** clears the session and bounces back to the access page.

Session notes:

- Closing the tab clears the session.
- Reloading the dashboard keeps it.
- Visiting `/dashboard.html` without a session redirects to the access page automatically.

Backward compat: the migration backfills any existing `submissions` that pre-date the column to `user_1` so the `NOT NULL` + `CHECK` constraint applies cleanly.

## 6c. Multi-poll

Swift Poll now supports multiple polls. Key behaviour:

- **Admin** creates polls from the dashboard: name, slug (unique, URL-safe), description, active flag. Edit or archive later.
- **Visibility mapping** via `poll_user_access` lets the admin toggle which non-admin users can access which poll. Admins always see every poll.
- **Respondent flow**: after entering name and picking a user from the dropdown, the poll page looks up polls visible to that user:
  - **0 polls** -> empty state message.
  - **1 poll** -> starts that poll directly.
  - **2+ polls** -> a card picker is shown; each card has the poll name, slug, and description. Tap a card to begin.
- **Dashboard** has a **Poll** selector at the top. Every section (aggregates, user-wise responses, manage questions, reset, CSV export) is scoped to the selected poll.
- **Reset** is now scoped to the selected poll only: it downloads a CSV for that poll, then deletes just that poll's questions / options / submissions / answers. Users and other polls are untouched.

### Migration notes

- The `polls` table gains `is_active`, `deleted_at`, `updated_at`.
- A new `poll_user_access(poll_id, dashboard_user_id, is_enabled)` table is introduced.
- Seed logic grants every existing non-admin user access to the existing default poll (`swift-poll-default`), so nothing breaks for current users.
- Existing submissions and questions remain tied to the default poll via `poll_id`.

### Option colours

MCQ option bars in the admin analytics now use a solid distinct palette assigned by option order (blue / green / amber / purple / red), not the legacy yes/no/not-sure shading.

## 7. How dashboard works

- **Aggregated counts**: one query fetches all `answers` for the active poll, then counts are tallied client-side. Questions and options come from a cached poll graph so empty options still render with 0.
- **User-wise responses**: a single joined query pulls each submission with its user and answers. Mobile renders stacked cards; desktop renders a sticky-headed table.
- **Refresh** re-runs all queries. **Export CSV** dumps the currently loaded submissions as a downloadable CSV (purely client-side).

Loading, error, and empty states are all handled.

---

## 8. How to add more questions

Questions now live in Supabase and are managed entirely from the admin dashboard.

### From the dashboard (recommended)

1. Open [`/dashboard.html`](dashboard.html) and enter the passcode.
2. In the **Manage questions** section, fill the form:
   - Question text (up to 150 chars)
   - Four options (up to 75 chars each, unique)
3. Click **Add Question**. The question appears immediately in the poll form, aggregated results, and user-wise responses.

### Deleting a question

1. Click **Delete** on any row in **Active questions**.
2. Confirm in the modal.
3. The question is **soft-deleted** (`is_active = false`, `deleted_at = now()`) along with its options. Historical submissions are preserved in the database but hidden from every UI.

### From SQL (power users)

You can still insert directly:

```sql
with p as (select id from polls where slug = 'swift-poll-default'),
     q as (
       insert into questions (poll_id, question_text, question_type, display_order)
       select id, 'Your new question text', 'single_select',
              coalesce((select max(display_order) from questions), 0) + 1 from p
       returning id
     )
insert into question_options (question_id, option_text, option_value, display_order)
select id, 'Yes',      'opt_1', 1 from q union all
select id, 'Not Sure', 'opt_2', 2 from q union all
select id, 'No',       'opt_3', 3 from q union all
select id, 'Skip',     'opt_4', 4 from q;
```

### Deletion strategy (why soft delete)

- `questions` and `question_options` carry `is_active` + `deleted_at`.
- Every read in the app filters `is_active = true and deleted_at is null`.
- Historical `answers` keep their FKs intact, so there is **zero risk of losing submission data** when an admin deletes a question.
- If you want a hard purge later, truncate inactive rows directly in SQL after you are sure no analytics depend on them.

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
