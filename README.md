# Swift Poll

A lightweight, mobile-first **multi-poll** web app. One question per screen, responses persisted to Supabase, and a role-aware dashboard with aggregates, user-wise breakdowns, CSV export, and full admin management of polls / questions / users. Pure static HTML / CSS / vanilla JavaScript — no build step, no framework. Deployable to Vercel on the free tier.

![Swift Poll](https://i.ibb.co/LDdkBqsS/image-4.png)

---

## Overview

Swift Poll is a self-contained Supabase-backed survey tool. The product surface has three audiences:

1. **Respondents** — visit the public site, enter a name, pick a "user bucket" (e.g. `User 1`...`User 6` or any name an admin creates), and answer the questions for the poll(s) they have access to.
2. **Dashboard users** (non-admin) — log in to view aggregated charts and user-wise responses for *only* the polls and the user-bucket scope they are mapped to.
3. **Admins** — log in to fully manage the system: create / edit / duplicate / archive polls, manage which buckets see which polls, add and soft-delete questions (MCQ or free-text), manage dashboard accounts, delete individual responses, reset a poll's data, and export CSVs.

Core design principles:

- **Zero build / zero backend code** — three static HTML pages and a handful of vanilla JS modules that talk to Supabase directly via the JS SDK loaded from a CDN.
- **Server-side admin enforcement** — every admin write goes through a `security definer` Postgres RPC that validates a 24-hour bearer token issued on bcrypt password verification. RLS leaves no open admin-write policies on the data tables.
- **Idempotent SQL setup** — [supabase-schema.sql](supabase-schema.sql) creates / migrates / seeds in a single re-runnable script.

### High-level user flows

- **Take poll**: [index.html](index.html) → **Start Poll** → [poll.html](poll.html) (identity → optional poll picker → questions → success).
- **View dashboard**: any "Dashboard" link → [dashboard-access.html](dashboard-access.html) → login → [dashboard.html](dashboard.html).
- **Admin**: same login, but the admin role unlocks management sections (poll management, manage questions, manage users, reset, etc.).

---

## Key Features

### Respondent flow ([js/poll.js](js/poll.js))
- **Identity screen** — required full name (`maxlength=120`) and required user-bucket dropdown loaded from `dashboard_active_user_accounts` RPC.
- **Multi-poll routing** — after identity, [poll.js:139](js/poll.js#L139) calls `polls_for_respondent` and:
  - 0 polls → empty-state screen.
  - 1 poll → starts it directly.
  - 2+ polls → renders a card picker; tap a card to begin.
- **Per-question screen** — progress bar, "Required / Optional" badge, MCQ or free-text body.
- **Question types**:
  - `single_select` — radio options (2–5).
  - `text_input` — multi-line textarea, 300 char limit, live counter.
- **Required vs optional** — required questions disable **Next** until answered; optional questions show a **Skip** button.
- **Back / Next / Skip / Submit** — sticky nav at the bottom; Submit replaces Next on the final question.
- **Submission** — inserts a `submissions` row and bulk-inserts `answers` (skipped questions are omitted; only non-skipped rows are sent).
- **Fresh start every visit** — drafts are intentionally cleared on load so respondents cannot resume a previous attempt ([poll.js:70](js/poll.js#L70)).
- **Toast confirmation** + success screen with **Back to Home** CTA.

### Dashboard ([js/dashboard.js](js/dashboard.js), [dashboard.html](dashboard.html))
- **Login gate** — [dashboard-access.js](js/dashboard-access.js) calls `dashboard_login` (bcrypt match in DB), receives a 24h token, stores `{ id, displayName, role, token }` in `sessionStorage`. Re-visiting the access page while authenticated forwards through.
- **Poll selector** — top filter; remembers last selection in `localStorage.swift_poll.selected_poll`.
- **User-bucket filter** — "View responses for" filters totals, aggregates, user-wise rows, and CSV export to one bucket or "All Users".
- **Aggregated results** — per-question option counts; bars use a fixed palette by option order (blue / green / amber / purple / red). Free-text questions show a count of submitted answers.
- **User-wise responses** — submissions table (desktop) / stacked cards (mobile) with full name, bucket, timestamp, every answer; **Delete** button on each row (admin only).
- **Refresh** — re-runs all queries.
- **Export CSV** — purely client-side, scoped to the current poll + user filter; filename includes slug, scope, and date.
- **Loading / error / empty states** — all handled.

### Admin features (gated by role + token)
- **Poll Management** — create poll, edit (name / description / status), duplicate, archive, manage visibility per dashboard user.
- **Manage Questions** — add MCQ (2–5 options) or text-input questions, mark required, soft-delete with confirm.
- **Manage Users** — add a non-admin dashboard user, rename, change password (modal), deactivate. The DB refuses to deactivate the **last** active admin.
- **Delete a response** — single-row delete via confirm modal.
- **Reset poll** — modal asks the user to type `RESET`, then downloads a CSV backup of every submission, then deletes the selected poll's questions / options / submissions / answers and demotes the poll to `draft`. Other polls and dashboard users untouched.
- **Poll lifecycle enforcement** — `admin_update_poll` refuses to set status `active` if the poll has no active questions. `admin_delete_question` automatically demotes the poll to `draft` if deleting the question leaves zero active ones.
- **Duplicate semantics** — `admin_duplicate_poll` copies the poll row + active questions/options into a new **draft** poll. Submissions, answers, and access mappings are intentionally not copied.

### Validation & limits
Centralised in [js/supabase.js:18-27](js/supabase.js#L18-L27) and mirrored as DB CHECK constraints:

| Field | Limit |
|---|---|
| Question text | 1–150 chars |
| Option text | 1–75 chars |
| Free-text answer | up to 300 chars |
| MCQ options | 2 min, 5 max, must be unique (case-insensitive) |
| Poll title | up to 120 chars |
| Poll slug | up to 60 chars, regex `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` |
| Poll description | up to 400 chars |
| Dashboard password | min 4 chars |

---

## Tech Stack

| Layer | Choice |
|---|---|
| Frontend | Static HTML5 + CSS3 + vanilla ES2017+ JavaScript |
| Backend / DB | Supabase (PostgreSQL + PostgREST + RLS + RPC) |
| Auth | Custom bcrypt-based dashboard login implemented in `pgcrypto`-backed RPCs (no Supabase Auth) |
| Client lib | `@supabase/supabase-js@2.45.4` via jsDelivr CDN |
| Hashing | `pgcrypto` `crypt(..., gen_salt('bf'))` |
| Hosting | Vercel static (configured in [vercel.json](vercel.json)) — works on any static host |
| Build / bundler | None |
| Tests | None present |

External dependencies are *only* the Supabase JS client (CDN) and a hosted brand logo from `i.ibb.co`. Everything else ships from this repo.

---

## Architecture

A pure 2-tier static-frontend + Postgres-on-Supabase setup:

```
Browser                                      Supabase project
─────────────────────────────────────        ─────────────────────────────
index.html / poll.html / dashboard.html      ┌── PostgREST  ◀─── reads
        │                                     │
        ▼                                     ├── RPC (security definer):
  js/config.js  ◀── credentials               │     dashboard_login / logout
  js/utils.js                                 │     dashboard_list_users
  js/supabase.js (data layer) ────HTTPS───────┤     polls_for_*  / admin_* …
  js/{main,poll,dashboard,                    │
      dashboard-access}.js                    └── Tables (RLS enabled):
                                                    users / polls / questions /
                                                    question_options / submissions /
                                                    answers / dashboard_users /
                                                    poll_user_access /
                                                    dashboard_sessions
```

### Page → script wiring

| Page | Script | Responsibility |
|---|---|---|
| [index.html](index.html) | [js/main.js](js/main.js) | Brand wiring, **Start Poll** CTA |
| [poll.html](poll.html) | [js/poll.js](js/poll.js) | Identity → picker → questions → success |
| [dashboard-access.html](dashboard-access.html) | [js/dashboard-access.js](js/dashboard-access.js) | Login form (RPC `dashboard_login`) |
| [dashboard.html](dashboard.html) | [js/dashboard.js](js/dashboard.js) | Filters, aggregates, user-wise, admin sections, modals |

Common scripts loaded everywhere (cache-busted via `?v=` in `<script src>`):
- [js/config.js](js/config.js) — `window.SWIFT_POLL_CONFIG` (Supabase URL/key + branding).
- [js/utils.js](js/utils.js) — UUID, session id, draft/user storage helpers, HTML escape, date format, toast, brand setter.
- [js/supabase.js](js/supabase.js) — singleton `SP.db` data-access layer (every Supabase call lives here).

### Directory layout

```
swift-poll/
├── index.html               Landing page
├── poll.html                Multi-step poll flow
├── dashboard-access.html    Dashboard login
├── dashboard.html           Aggregates + admin UI
├── vercel.json              Static hosting + security headers
├── supabase-schema.sql      Tables, indexes, RLS, RPCs, seeds
├── .env                     Local-only config reference (NOT served)
├── .gitignore
├── README.md                (this file)
├── css/
│   └── styles.css           Single global stylesheet (`sp-` BEM-ish prefix)
├── js/
│   ├── config.js            Runtime config
│   ├── utils.js             Helpers, storage keys
│   ├── supabase.js          Data layer + admin RPC token wiring
│   ├── main.js              index.html bindings
│   ├── poll.js              poll.html state machine
│   ├── dashboard-access.js  login screen
│   └── dashboard.js         dashboard controller
└── assets/                  (empty; brand logo is hosted externally)
```

---

## Business Logic / Application Logic

### Poll lifecycle (`polls.status`)

Defined as `CHECK (status in ('draft','active','archived'))`:

- **draft** — admin-editable; hidden from respondents.
- **active** — visible to mapped buckets in the respondent picker; visible to dashboard users mapped to it.
- **archived** — hidden from respondents and non-admin dashboard users; admins can still inspect / un-archive.

Transitions enforced server-side:

- New polls (`admin_create_poll`) → start as `draft`.
- Duplicates (`admin_duplicate_poll`) → start as `draft`.
- `admin_update_poll` raises if you try to set `active` with zero active questions.
- `admin_delete_question` demotes the poll back to `draft` if the deleted question was the last one ([schema:790](supabase-schema.sql#L790)).
- `admin_reset_poll` deletes the poll's questions/options/submissions/answers and demotes the poll to `draft`.

### Visibility model

- `dashboard_users.role` = `admin` | `user`.
- Admins implicitly see every poll (`polls_for_dashboard_user` short-circuits if the caller is an active admin).
- Non-admin dashboard users see a poll only if `poll_user_access(poll_id, dashboard_user_id, is_enabled=true)` exists.
- Respondents pick a "user bucket" from the active **non-admin** users, and `polls_for_respondent` returns all `active` polls mapped to that bucket.

### Auth / session model

- `dashboard_login(display_name, password)` is a `security definer` RPC that:
  1. Looks up the user (case-insensitive `display_name`, `is_active`, not soft-deleted).
  2. Compares `crypt(password, password_hash)` against the stored bcrypt hash.
  3. On success, opportunistically prunes expired sessions, inserts a row into `dashboard_sessions` with `expires_at = now() + 24 hours`, returns `(id, display_name, role, token)`.
- Client stores `{ id, displayName, role, token }` in `sessionStorage` under key `swift_poll.dashboard_session`.
- Every admin write RPC starts with `perform validate_admin(p_token)` which raises `unauthorized (42501)` unless the token is unexpired AND tied to an active `admin`.
- `dashboard_logout(token)` deletes the session row; logout is idempotent.

### Answer integrity

`answers_kind_chk` (CHECK constraint) requires:
- An MCQ answer has `selected_option_id NOT NULL` and `text_answer IS NULL`, **or**
- A text answer has `selected_option_id IS NULL` and `char_length(text_answer) ≤ 300`.

Plus `UNIQUE (submission_id, question_id)` so a submission can never have two answers for the same question.

### Submission write path

[supabase.js:312](js/supabase.js#L312) `submitPoll`:

1. Insert one `submissions` row (`poll_id`, `user_id`, `assigned_user_id`, `status='submitted'`).
2. Map answers, dropping any with `skipped: true`.
3. Bulk-insert `answers`. Failure here leaves an empty submission — acceptable because it just means an empty row in dashboards (and the dashboard renders 0/missing answers cleanly).

This is *not* wrapped in a transaction (PostgREST supports that only via RPC). For most use cases the consequence is benign; a respondent re-submitting is the simplest recovery.

### Soft-delete strategy

- `questions.is_active`, `questions.deleted_at`, and the same on `question_options` — every read filters `is_active = true and deleted_at is null`.
- Historical `answers` keep their FKs intact, so deleting a question never destroys past submission data.
- `dashboard_users` similarly soft-delete (`is_active=false`, `deleted_at=now()`); the RPC for delete-user refuses to drop the last active admin.
- Polls archive (`status='archived'`, `deleted_at` set) rather than drop; only `admin_reset_poll` truly deletes related rows.

### Caching

- `js/supabase.js` keeps a per-poll `getActiveQuestions` cache (`questionsCacheByPoll`). It is invalidated whenever a question is created or soft-deleted, and on `admin_reset_poll`.
- Dashboard tallies are computed client-side from a single `answers` join. Fine for thousands of submissions; for very large datasets you can flip the dashboard to use the `v_question_option_counts` view (created by the schema, currently unused by the frontend).

---

## API Documentation

All "API" calls go to Supabase. The client uses two flavours: PostgREST table calls (for reads + the public respondent writes) and `rpc()` calls (for everything admin-gated and a few helpers). The complete set is implemented in [js/supabase.js](js/supabase.js).

### PostgREST table operations

| Op | Table | Caller / Use |
|---|---|---|
| `select` | `polls` | Admin: list all polls |
| `select` | `questions` w/ nested `question_options` | Render active questions |
| `select` | `submissions` w/ nested `users`, `assigned`, `answers.question` | User-wise responses |
| `select count` | `submissions` | Total submissions stat |
| `select count` | `questions` (active) | Poll stats card |
| `select count` | `poll_user_access` (`is_enabled`) | Poll stats card |
| `select` | `poll_user_access` | Visibility modal |
| `select` | `answers` joined to `submissions!inner` | Aggregated counts per option |
| `insert` | `users` | Respondent creates a respondent record |
| `insert` | `submissions` | Respondent submits |
| `insert` | `answers` | Respondent submits |

### RPC functions (defined in [supabase-schema.sql](supabase-schema.sql))

Every `admin_*` RPC requires `p_token` from a successful `dashboard_login` and validates an active admin via `validate_admin`. They return `unauthorized (42501)` otherwise.

| RPC | Purpose | Args | Returns |
|---|---|---|---|
| `dashboard_login` | Bcrypt verify + issue 24h token | `p_display_name text, p_password text` | `(id, display_name, role, token)` (empty on failure) |
| `dashboard_logout` | Delete session | `p_token uuid` | `void` |
| `validate_admin` | Internal helper used by admin RPCs | `p_token uuid` | `uuid` (admin id) or raises |
| `dashboard_list_users` | List dashboard users (no hashes) | — | `(id, display_name, role, is_active, created_at)` |
| `dashboard_active_user_accounts` | Active non-admin user buckets | — | `(id, display_name)` |
| `polls_for_respondent` | Active polls visible to a bucket | `p_dashboard_user_id uuid` | `(id, slug, title, description)` |
| `polls_for_dashboard_user` | Polls visible to a dashboard user (admin sees all) | `p_user_id uuid` | `(id, slug, title, description, status)` |
| `admin_create_poll` | New poll (`draft`) | `p_token, p_title, p_slug, p_description` | `uuid` |
| `admin_update_poll` | Update title/description/status | `p_token, p_id, p_title, p_description, p_status` | `void` |
| `admin_duplicate_poll` | Copy poll + active questions/options | `p_token, p_source_id, p_new_slug, p_new_title` | `uuid` |
| `admin_set_poll_access` | Upsert visibility for one user | `p_token, p_poll_id, p_user_id, p_enabled` | `void` |
| `admin_create_question` | New question + options | `p_token, p_poll_id, p_text, p_type, p_is_required, p_options text[]` | `uuid` |
| `admin_delete_question` | Soft-delete + maybe demote poll | `p_token, p_question_id` | `void` |
| `admin_create_user` | Create non-admin dashboard user | `p_token, p_display_name, p_password` | `uuid` |
| `admin_rename_user` | Rename user | `p_token, p_id, p_new_name` | `void` |
| `admin_change_password` | Change password (bcrypt) | `p_token, p_id, p_new_password` | `void` |
| `admin_delete_user` | Soft-delete (refuses last admin) | `p_token, p_id` | `void` |
| `admin_delete_submission` | Hard-delete one submission | `p_token, p_submission_id` | `void` |
| `admin_reset_poll` | Wipe a single poll's data | `p_token, p_poll_id` | `void` |

### Error model

Friendly mappings are in `friendlyError` of each script ([dashboard.js:1065](js/dashboard.js#L1065), [poll.js:338](js/poll.js#L338), [dashboard-access.js:88](js/dashboard-access.js#L88)). They translate:

- `Supabase URL not configured` → "App is not configured yet…"
- `Failed to fetch` / `NetworkError` → "Network issue…"
- `function … does not exist` / `relation … does not exist` → "Database is out of date / tables missing — re-run supabase-schema.sql."
- `unauthorized` / `42501` → "Your admin session has expired. Please log in again."
- `row-level security` → "Database blocked the write — re-run supabase-schema.sql."
- `duplicate key` → "That slug is already used…"

---

## Data Model / Database

All defined in [supabase-schema.sql](supabase-schema.sql). The script is idempotent: tables are `create if not exists`, columns are added via `add column if not exists`, constraints with guarded `do $$ … $$`.

### Tables

| Table | Purpose | Key columns |
|---|---|---|
| `users` | Respondent identity (one row per poll attempt) | `id`, `full_name`, `contact_value` (unused), `session_id`, `created_at` |
| `polls` | One row per poll | `id`, `slug` (unique), `title`, `description`, `status` (`draft|active|archived`), legacy `is_active`, `deleted_at`, `updated_at` |
| `questions` | A poll's questions | `id`, `poll_id` (FK), `question_text`, `question_type` (`single_select|text_input`), `display_order`, `is_active`, `is_required`, `deleted_at` |
| `question_options` | MCQ choices | `id`, `question_id` (FK), `option_text`, `option_value`, `display_order`, `is_active`, `deleted_at` |
| `submissions` | One row per respondent submission | `id`, `poll_id`, `user_id`, `assigned_user_id` (FK→`dashboard_users`), `submitted_at`, `status` |
| `answers` | One row per (submission, question) | `id`, `submission_id`, `question_id`, `selected_option_id`, `selected_option_text`, `text_answer` |
| `dashboard_users` | Login accounts (admin + scoped users) | `id`, `display_name`, `role`, `password_hash` (bcrypt), `is_active`, `deleted_at` |
| `dashboard_sessions` | Bearer tokens issued on login | `token` (uuid PK), `dashboard_user_id`, `role`, `expires_at`, `created_at` |
| `poll_user_access` | Per-user visibility map | `id`, `poll_id`, `dashboard_user_id`, `is_enabled`; `UNIQUE(poll_id, dashboard_user_id)` |

### Key indexes

- `users(created_at desc)`, `users(session_id)`
- `questions(poll_id)`, `questions(poll_id, display_order)`, `questions(poll_id, is_active, deleted_at)`
- `question_options(question_id)`, `question_options(question_id, is_active, deleted_at)`, **unique** `(question_id, option_value)`
- `submissions(poll_id)`, `submissions(user_id)`, `submissions(submitted_at desc)`, `submissions(assigned_user_id)`
- `answers(submission_id)`, `answers(question_id)`, `answers(selected_option_id)`
- `polls(is_active, deleted_at)`, `polls(status)`
- `dashboard_sessions(dashboard_user_id)`, `dashboard_sessions(expires_at)`
- `poll_user_access(poll_id)`, `poll_user_access(dashboard_user_id)`
- **Unique** `dashboard_users(lower(display_name)) where deleted_at is null`

### Constraints

- `questions_text_length_chk` — `1 ≤ char_length ≤ 150`
- `questions_type_chk` — `question_type in ('single_select','text_input')`
- `question_options_text_length_chk` — `1 ≤ char_length ≤ 75`
- `answers_kind_chk` — MCQ XOR text answer (see logic above)
- `dashboard_users_role_chk` — `role in ('admin','user')`
- `polls_status_chk` — `status in ('draft','active','archived')`
- `submissions_assigned_user_fk` — FK to `dashboard_users`
- `submissions.assigned_user_id` is `NOT NULL` post-migration

### Views

- `v_question_option_counts` — per-question option response counts. Currently **not** used by the frontend; available as a hook to move counts to the server.

### Seed data

Run automatically by [supabase-schema.sql](supabase-schema.sql):

- One poll: slug `swift-poll-default`, title `"Does your learning system..."`.
- Six legacy questions (Yes / Not Sure / No), inserted only if not already present.
- Seven dashboard accounts (skipped if already there): `Admin/1234`, `User 1`...`User 6` all with password `user`.
- `poll_user_access` rows granting every seeded non-admin user access to the default poll.
- A backward-compat migration that maps old text `submissions.assigned_user` (`user_1`..`user_6`) onto the new FK, then drops the legacy column and tightens the new column to `NOT NULL`.

### Migrations

The script handles in-place upgrades to existing installs:

- Adds `is_active`, `is_required`, `deleted_at`, `updated_at` to legacy `questions`.
- Adds `is_active`, `deleted_at`, `created_at` to legacy `question_options`.
- Adds `text_answer` to legacy `answers`.
- Adds `assigned_user_id` to legacy `submissions`, backfills it from the old text column, and tightens `NOT NULL` once safe.
- Adds `is_active`, `deleted_at`, `updated_at`, `status` to legacy `polls` and backfills `status`.
- Drops MCQ-specific NOT NULL on `answers.selected_option_id` / `selected_option_text` so text answers can store only `text_answer`.

---

## Environment Variables

Because this is a static frontend, **runtime values live in [js/config.js](js/config.js)**, not in the OS env. The repo also includes a `.env` reference for documentation / for a hypothetical build step that injects the values.

| Name | Where | Required | Default | Purpose |
|---|---|---|---|---|
| `SUPABASE_URL` | `js/config.js` (`SUPABASE_URL`), `.env` | Yes | — | Supabase project URL (`https://<ref>.supabase.co`) |
| `SUPABASE_ANON_KEY` | `js/config.js` (`SUPABASE_ANON_KEY`), `.env` | Yes | — | Public `anon` key — safe to ship; constrained by RLS |
| `BRAND_NAME` | `js/config.js` | No | `"Swift Poll"` | Header text / browser title segments |
| `BRAND_LOGO` | `js/config.js` | No | hosted logo | Hero / header logo URL |
| `POLL_SLUG` | `js/config.js`, `.env` | No | `"swift-poll-default"` | Inferred default poll slug; multi-poll routing now resolves polls per-user, but the slug is still surfaced in CSV filenames |
| `POLL_TITLE` | `js/config.js` | No | from seed | Display title fallback |
| `POLL_INTRO` | `js/config.js` | No | string | Hero subtitle |
| `DASHBOARD_PASSCODE` | `.env` only | Inferred legacy | `1234` | Documented in the legacy README; current dashboard auth uses `dashboard_login` RPC and does **not** read this value. **(Inferred: vestigial.)** |

> ⚠️ The `anon` key is intentionally public. Never paste a `service_role` key into `js/config.js` — it bypasses RLS.

> ℹ️ `.env` is present in the repo (and listed in `.gitignore`) for local reference only. **It is not loaded by any runtime** — the static page reads `js/config.js` directly. To use `.env` for credentials, wire up a deploy-time script that templates `js/config.js` from the env vars (Vercel build step, GitHub Actions, etc.).

---

## Installation

### Prerequisites

- A modern browser.
- A static file server (Python, Node, VS Code Live Server — anything).
- A free Supabase project.

### 1. Clone / unzip

```bash
git clone <your-fork-url> swift-poll
cd swift-poll
```

### 2. Provision Supabase

1. Sign up at [supabase.com](https://supabase.com), create a new project (Mumbai/Singapore for India).
2. **Project Settings → API** → copy the **Project URL** and the **anon public** key.
3. Open **SQL Editor → New query**, paste the entire contents of [supabase-schema.sql](supabase-schema.sql), and run it.

The script creates every table, index, RLS policy, RPC, the seed poll, and the seven default dashboard accounts. Re-running it on an existing project performs migrations only — no duplicate data.

### 3. Configure the frontend

Edit [js/config.js](js/config.js):

```js
window.SWIFT_POLL_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY",
  BRAND_NAME: "Swift Poll",
  BRAND_LOGO: "https://i.ibb.co/LDdkBqsS/image-4.png",
  POLL_SLUG: "swift-poll-default",
  POLL_TITLE: "Does your learning system...",
  POLL_INTRO: "Answer a few quick questions. Takes less than a minute."
};
```

### 4. Change default credentials (production)

The SQL seed creates `Admin/1234` and `User 1..6` with password `user`. Log in as Admin → **Manage users** → change every password before exposing the deployment publicly.

---

## Running the Project

### Local development

```bash
# Option A — Python (no install needed)
python -m http.server 5173

# Option B — Node
npx serve .

# Option C — VS Code "Live Server" extension
```

Then open <http://localhost:5173/>. Opening files via `file://` will not work — Supabase requires `http(s)`.

### Available commands

There are no `package.json` scripts. The full inventory of "commands":

| Command | Effect |
|---|---|
| `python -m http.server 5173` | Local dev server |
| `npx serve .` | Alternate dev server |
| `vercel` / `vercel --prod` | Deploy to Vercel (after `npm i -g vercel`) |
| Re-run [supabase-schema.sql](supabase-schema.sql) in Supabase SQL Editor | Apply schema migrations |

---

## Testing

**No automated tests are present in the repository.** Manual QA paths to cover:

- **Respondent**: identity validation, empty-state when 0 polls, single-poll auto-start, multi-poll picker, MCQ + text + required + optional + skip + back, submit with required missing → blocked, submit success.
- **Login**: wrong password / unknown user, expired token (after 24h), logout clears session.
- **Dashboard**: poll selector switching, user filter switching, refresh, CSV export across both filters, empty state.
- **Admin**: create / edit / archive / duplicate poll, set poll active without questions (must fail), delete last active question on an active poll (must demote to draft), add MCQ with <2 / >5 / duplicate options, add text question, soft-delete question, manage visibility, add user, rename, change password, delete last admin (must fail), delete submission, reset poll (CSV downloads, data wiped, other polls untouched).

---

## Deployment

### Vercel (recommended)

**CLI**:

```bash
npm i -g vercel
vercel            # first run links / creates project
vercel --prod     # subsequent prod deploys
```

**GitHub integration**:

1. Push the repo to GitHub.
2. <https://vercel.com/new> → Import.
3. Framework preset: **Other**. Build command: *(blank)*. Output directory: *(blank)*.
4. Deploy.

[vercel.json](vercel.json) configures:

- `cleanUrls: true`, `trailingSlash: false`.
- Security headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: SAMEORIGIN`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- `Cache-Control: public, max-age=3600, must-revalidate` on `/css/*` and `/js/*` (cache-busting via `?v=` query string in `<script>` tags).

### Other static hosts

Any static host works (Netlify, Cloudflare Pages, GitHub Pages, S3 + CloudFront). Make sure to ship the same security headers if your host doesn't already.

### Credentials at deploy

Vercel env vars do **not** auto-populate static JS. Either:
- Hard-code values in `js/config.js` (simplest — anon key is public anyway), or
- Add a deploy-time templating step that injects them.

---

## Security / Permissions

### Authentication

- Passwords stored as bcrypt hashes via `pgcrypto.crypt(..., gen_salt('bf'))`.
- Passwords are never returned to the client; `dashboard_users` is **not** directly queryable by anon (no select policy).
- `dashboard_login` is the only path to a token; it never returns the hash.
- Sessions are 24 hours, stored in `dashboard_sessions`. Expired sessions are pruned opportunistically on every login.

### Authorization

- **RLS is enabled on every table.**
- **Read** policies are open (`using (true)`) on `users`, `polls`, `questions`, `question_options`, `submissions`, `answers`, `poll_user_access` — required for the dashboard and poll rendering.
- **Anon writes** are scoped exactly to the respondent path: `insert` on `users`, `submissions`, `answers`. Everything else has *no* policy and is therefore denied.
- Admin writes go through `security definer` RPCs that call `validate_admin` first. The token model means even a leaked anon key cannot perform admin actions without the bearer token.
- The **last active admin** cannot be deactivated (`admin_delete_user` raises).

### Token surface

- Tokens live in `sessionStorage` (cleared when the tab closes).
- A token leaked from an open admin session lets an attacker impersonate the admin **until expiry** (24h). Mitigations: short tab lifetime + manual logout + admin password rotation.

### Headers (`vercel.json`)

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `X-Frame-Options: SAMEORIGIN`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

### Hardening ideas (Inferred)

1. Migrate to Supabase Auth + JWT-scoped RLS (proper end-to-end auth).
2. Move user-wise queries behind a `security definer` RPC and deny direct select on `users`/`answers`.
3. Add a Turnstile/hCaptcha-protected Edge Function in front of submission inserts to deter automated stuffing.

---

## Error Handling & Logging

- All async paths log raw errors with `console.error` and surface a friendly message via the `friendlyError` mapper in each script.
- Toasts (`SP.utils.toast`) for non-blocking confirmations.
- Modal confirmations for destructive actions (delete question, delete submission, archive poll, reset poll, change password). Reset additionally requires typing `RESET`.
- No remote logging, no Sentry, no analytics — by design.
- Network resilience: each call is retryable by user action; there is no automatic retry/backoff.

---

## Known Constraints

- **No automated tests** — every change is verified by manual exercise.
- **No Supabase Auth** — the bearer-token model is solid against drive-by attackers but not against a leaked token. Long-term this should be migrated.
- **`DASHBOARD_PASSCODE` is vestigial** — present in `.env` and the legacy README, no longer read by the frontend (login is per-user via `dashboard_login`).
- **Submission insert is not a transaction** — partial submissions theoretically possible if `answers` insert fails after `submissions` insert.
- **Client-side aggregation** — fine through thousands of submissions; needs `v_question_option_counts` (already in the schema) once datasets get large.
- **Bundled secret** — the `anon` key is exposed in plaintext in `js/config.js`. This is intentional and safe **only** because RLS is correctly configured. Misconfigured RLS = data leak.
- **`assets/` is empty** — the brand logo is loaded from a public CDN, not the repo.
- **`.env` is in `.gitignore`** but currently checked in. Either remove it from version control or remove the line from `.gitignore` for clarity.
- **`supabase-schema.sql` is in `.gitignore`** but checked in (likely a leftover; the file is intended to be source-controlled).
- **No FIXME/TODO** comments in the codebase to track.

---

## Future Improvements

- **Supabase Auth migration** for first-class JWT-scoped RLS, real password reset flows, and SSO options.
- **Server-side aggregation** via `v_question_option_counts` for very large datasets.
- **Multi-question types** beyond MCQ + text (rating scale, multi-select, ranking).
- **Per-poll branding** (logo / theme) overriding global config.
- **Audit log** for admin actions (created when, by whom — useful for compliance).
- **Rate limiting / CAPTCHA** on the public submit path.
- **PWA** — installable, offline draft if the app pivots toward kiosks.
- **Automated tests** — Playwright for end-to-end on the three pages, pgTAP for DB invariants.
- **CI** — GitHub Actions to run schema lint, Playwright, and a Vercel preview deploy on PR.
- **Localisation** — UI copy is currently English-only.

---

## Contribution Guidelines

> No formal `CONTRIBUTING.md` is present; the conventions below are **inferred** from the existing code.

- **Branching** — feature branches off `main`, descriptive names (e.g. `feat/poll-archiving`, `fix/csv-escape`). The repo's recent commits show short imperative subjects (`feat: …`, `refactor: …`).
- **Commits** — Conventional-style prefixes are used (`feat`, `refactor`, `fix`). Keep them small and focused.
- **Pull requests** — describe the user-facing behaviour and any schema migration impact. If you change `supabase-schema.sql`, ensure the script remains idempotent.
- **Code style** — vanilla JS, ES2017+, single-quoted strings predominantly, modular IIFE-per-file pattern, all DOM access via `[data-…]` attributes. Stick to the `sp-` CSS class prefix.
- **Testing expectations** — manually cover the QA matrix above. Add automated tests opportunistically.
- **Security** — never commit a `service_role` key; never log credentials; keep all admin writes behind RPC tokens.

---

## Folder layout

```
swift-poll/
  index.html
  poll.html
  dashboard-access.html
  dashboard.html
  vercel.json
  supabase-schema.sql
  README.md
  .env
  .gitignore
  css/
    styles.css
  js/
    config.js
    utils.js
    supabase.js
    main.js
    poll.js
    dashboard-access.js
    dashboard.js
  assets/
```
