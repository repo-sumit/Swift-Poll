-- =============================================================
-- Swift Poll - Supabase Schema
-- =============================================================
-- Run this file in the Supabase SQL editor. It is idempotent -
-- safe to re-run for new installs, upgrades, or schema drift.
--
-- Ordering:
--   1. Create tables (IF NOT EXISTS, so existing tables stay)
--   2. Migrations: ALTER IF NOT EXISTS to bring pre-existing
--      tables up to current column set
--   3. Indexes (now safe to reference new columns)
--   4. Constraints (CHECK)
--   5. RLS policies
--   6. Seed data
--   7. View
-- =============================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 1. TABLES (fresh-install shape)
-- -------------------------------------------------------------
create table if not exists public.users (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null,
  contact_value  text,
  session_id     text,
  created_at     timestamptz not null default now()
);

create table if not exists public.polls (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  title       text not null,
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists public.questions (
  id            uuid primary key default gen_random_uuid(),
  poll_id       uuid not null references public.polls(id) on delete cascade,
  question_text text not null,
  question_type text not null default 'single_select',
  display_order int  not null default 0,
  is_active     boolean not null default true,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.question_options (
  id             uuid primary key default gen_random_uuid(),
  question_id    uuid not null references public.questions(id) on delete cascade,
  option_text    text not null,
  option_value   text not null,
  display_order  int  not null default 0,
  is_active      boolean not null default true,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now()
);

create table if not exists public.submissions (
  id           uuid primary key default gen_random_uuid(),
  poll_id      uuid not null references public.polls(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  status       text not null default 'submitted'
);

create table if not exists public.answers (
  id                   uuid primary key default gen_random_uuid(),
  submission_id        uuid not null references public.submissions(id) on delete cascade,
  question_id          uuid not null references public.questions(id) on delete cascade,
  selected_option_id   uuid not null references public.question_options(id),
  selected_option_text text not null,
  created_at           timestamptz not null default now(),
  unique (submission_id, question_id)
);

-- -------------------------------------------------------------
-- 2. MIGRATIONS - add any columns that older installs lacked.
--    IMPORTANT: this must run BEFORE indexes / constraints that
--    reference these columns.
-- -------------------------------------------------------------
alter table public.questions        add column if not exists is_active  boolean not null default true;
alter table public.questions        add column if not exists deleted_at timestamptz;
alter table public.questions        add column if not exists updated_at timestamptz not null default now();
alter table public.question_options add column if not exists is_active  boolean not null default true;
alter table public.question_options add column if not exists deleted_at timestamptz;
alter table public.question_options add column if not exists created_at timestamptz not null default now();

-- User segmentation on submissions. Add nullable first, backfill,
-- then enforce NOT NULL + CHECK. Safe to re-run.
alter table public.submissions add column if not exists assigned_user text;
update public.submissions set assigned_user = 'user_1' where assigned_user is null;
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'submissions'
      and column_name  = 'assigned_user'
      and is_nullable  = 'YES'
  ) then
    alter table public.submissions alter column assigned_user set not null;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'submissions_assigned_user_chk') then
    alter table public.submissions
      add constraint submissions_assigned_user_chk
      check (assigned_user in ('user_1','user_2','user_3','user_4','user_5','user_6'));
  end if;
end $$;

-- -------------------------------------------------------------
-- 3. INDEXES (safe now that columns exist)
-- -------------------------------------------------------------
create index if not exists users_created_at_idx              on public.users (created_at desc);
create index if not exists users_session_id_idx              on public.users (session_id);

create index if not exists questions_poll_id_idx             on public.questions (poll_id);
create index if not exists questions_order_idx               on public.questions (poll_id, display_order);
create index if not exists questions_is_active_idx           on public.questions (poll_id, is_active, deleted_at);

create index if not exists question_options_question_id_idx  on public.question_options (question_id);
create index if not exists question_options_is_active_idx    on public.question_options (question_id, is_active, deleted_at);
create unique index if not exists question_options_unique_value
  on public.question_options (question_id, option_value);

create index if not exists submissions_poll_id_idx           on public.submissions (poll_id);
create index if not exists submissions_user_id_idx           on public.submissions (user_id);
create index if not exists submissions_submitted_at_idx      on public.submissions (submitted_at desc);
create index if not exists submissions_assigned_user_idx     on public.submissions (assigned_user);

create index if not exists answers_submission_id_idx         on public.answers (submission_id);
create index if not exists answers_question_id_idx           on public.answers (question_id);
create index if not exists answers_option_id_idx             on public.answers (selected_option_id);

-- -------------------------------------------------------------
-- 4. CHECK CONSTRAINTS (idempotent)
-- -------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'questions_text_length_chk') then
    alter table public.questions
      add constraint questions_text_length_chk check (char_length(question_text) between 1 and 150);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'questions_type_chk') then
    alter table public.questions
      add constraint questions_type_chk check (question_type in ('single_select'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'question_options_text_length_chk') then
    alter table public.question_options
      add constraint question_options_text_length_chk check (char_length(option_text) between 1 and 75);
  end if;
end $$;

-- =============================================================
-- 5. ROW LEVEL SECURITY
-- =============================================================
-- Dashboard is gated client-side by a passcode. Admin writes
-- (insert/update on questions + question_options) are allowed
-- for anon. For stricter production: move admin to Supabase
-- Auth and scope these policies to an authenticated role.
-- =============================================================
alter table public.users            enable row level security;
alter table public.polls            enable row level security;
alter table public.questions        enable row level security;
alter table public.question_options enable row level security;
alter table public.submissions      enable row level security;
alter table public.answers          enable row level security;

drop policy if exists "read users"            on public.users;
drop policy if exists "read polls"            on public.polls;
drop policy if exists "read questions"        on public.questions;
drop policy if exists "read question_options" on public.question_options;
drop policy if exists "read submissions"      on public.submissions;
drop policy if exists "read answers"          on public.answers;

create policy "read users"            on public.users            for select using (true);
create policy "read polls"            on public.polls            for select using (true);
create policy "read questions"        on public.questions        for select using (true);
create policy "read question_options" on public.question_options for select using (true);
create policy "read submissions"      on public.submissions      for select using (true);
create policy "read answers"          on public.answers          for select using (true);

drop policy if exists "insert users"       on public.users;
drop policy if exists "insert submissions" on public.submissions;
drop policy if exists "insert answers"     on public.answers;

create policy "insert users"       on public.users       for insert with check (true);
create policy "insert submissions" on public.submissions for insert with check (true);
create policy "insert answers"     on public.answers     for insert with check (true);

drop policy if exists "admin insert questions"        on public.questions;
drop policy if exists "admin update questions"        on public.questions;
drop policy if exists "admin insert question_options" on public.question_options;
drop policy if exists "admin update question_options" on public.question_options;

create policy "admin insert questions"        on public.questions        for insert with check (true);
create policy "admin update questions"        on public.questions        for update using (true) with check (true);
create policy "admin insert question_options" on public.question_options for insert with check (true);
create policy "admin update question_options" on public.question_options for update using (true) with check (true);

-- =============================================================
-- 6. SEED DATA - default poll + 6 seed questions with Yes/Not Sure/No
-- =============================================================
insert into public.polls (slug, title, description)
values (
  'swift-poll-default',
  'Does your learning system...',
  'Quick pulse-check on personalised learning readiness.'
)
on conflict (slug) do nothing;

do $$
declare
  v_poll_id uuid;
  v_q_id    uuid;
  v_idx     int;
  v_texts   text[] := array[
    'Knows where each child actually is in their learning - not just which grade they are in',
    'Gives every student a different path based on their level - automatically',
    'Lets the struggling child start from where they are - without shame, without being singled out',
    'Keeps the advanced child challenged and engaged - without waiting for the teacher to notice',
    'Adjusts itself as the child improves - harder when they are ready, simpler when they are stuck',
    'Assesses students regularly - tracking progress at every step, not just at the end of a term'
  ];
begin
  select id into v_poll_id from public.polls where slug = 'swift-poll-default';

  for v_idx in 1 .. array_length(v_texts, 1) loop
    select id into v_q_id
    from public.questions
    where poll_id = v_poll_id and question_text = v_texts[v_idx];

    if v_q_id is null then
      insert into public.questions (poll_id, question_text, question_type, display_order, is_active)
      values (v_poll_id, v_texts[v_idx], 'single_select', v_idx, true)
      returning id into v_q_id;

      insert into public.question_options (question_id, option_text, option_value, display_order) values
        (v_q_id, 'Yes',      'yes',      1),
        (v_q_id, 'Not Sure', 'not_sure', 2),
        (v_q_id, 'No',       'no',       3);
    end if;
  end loop;
end $$;

-- =============================================================
-- 7. AGGREGATED VIEW (active only)
-- =============================================================
drop view if exists public.v_question_option_counts;
create view public.v_question_option_counts as
select
  q.id            as question_id,
  q.question_text,
  q.display_order as question_order,
  o.id            as option_id,
  o.option_text,
  o.option_value,
  o.display_order as option_order,
  count(a.id)::int as response_count
from public.questions q
join public.question_options o
  on o.question_id = q.id
 and o.is_active = true
 and o.deleted_at is null
left join public.answers a on a.selected_option_id = o.id
where q.is_active = true and q.deleted_at is null
group by q.id, q.question_text, q.display_order, o.id, o.option_text, o.option_value, o.display_order
order by q.display_order, o.display_order;
