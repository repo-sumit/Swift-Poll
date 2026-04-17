-- =============================================================
-- Swift Poll - Supabase Schema
-- =============================================================
-- Run this file in the Supabase SQL editor (SQL -> New query)
-- to provision all tables, indexes, constraints, and seed data.
-- Safe to re-run: uses IF NOT EXISTS and ON CONFLICT.
-- =============================================================

-- Extension for UUID generation
create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- USERS
-- -------------------------------------------------------------
create table if not exists public.users (
  id             uuid primary key default gen_random_uuid(),
  full_name      text not null,
  contact_value  text,
  session_id     text,
  created_at     timestamptz not null default now()
);

create index if not exists users_created_at_idx on public.users (created_at desc);
create index if not exists users_session_id_idx on public.users (session_id);

-- -------------------------------------------------------------
-- POLLS
-- -------------------------------------------------------------
create table if not exists public.polls (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  title       text not null,
  description text,
  created_at  timestamptz not null default now()
);

-- -------------------------------------------------------------
-- QUESTIONS
-- -------------------------------------------------------------
create table if not exists public.questions (
  id            uuid primary key default gen_random_uuid(),
  poll_id       uuid not null references public.polls(id) on delete cascade,
  question_text text not null,
  question_type text not null default 'single_select',
  display_order int  not null default 0,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create index if not exists questions_poll_id_idx on public.questions (poll_id);
create index if not exists questions_order_idx   on public.questions (poll_id, display_order);

-- -------------------------------------------------------------
-- QUESTION OPTIONS
-- -------------------------------------------------------------
create table if not exists public.question_options (
  id             uuid primary key default gen_random_uuid(),
  question_id    uuid not null references public.questions(id) on delete cascade,
  option_text    text not null,
  option_value   text not null,
  display_order  int  not null default 0
);

create index if not exists question_options_question_id_idx on public.question_options (question_id);
create unique index if not exists question_options_unique_value
  on public.question_options (question_id, option_value);

-- -------------------------------------------------------------
-- SUBMISSIONS
-- -------------------------------------------------------------
create table if not exists public.submissions (
  id           uuid primary key default gen_random_uuid(),
  poll_id      uuid not null references public.polls(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  submitted_at timestamptz not null default now(),
  status       text not null default 'submitted'
);

create index if not exists submissions_poll_id_idx on public.submissions (poll_id);
create index if not exists submissions_user_id_idx on public.submissions (user_id);
create index if not exists submissions_submitted_at_idx on public.submissions (submitted_at desc);

-- -------------------------------------------------------------
-- ANSWERS
-- -------------------------------------------------------------
create table if not exists public.answers (
  id                   uuid primary key default gen_random_uuid(),
  submission_id        uuid not null references public.submissions(id) on delete cascade,
  question_id          uuid not null references public.questions(id) on delete cascade,
  selected_option_id   uuid not null references public.question_options(id),
  selected_option_text text not null,
  created_at           timestamptz not null default now(),
  unique (submission_id, question_id)
);

create index if not exists answers_submission_id_idx on public.answers (submission_id);
create index if not exists answers_question_id_idx   on public.answers (question_id);
create index if not exists answers_option_id_idx     on public.answers (selected_option_id);

-- =============================================================
-- ROW LEVEL SECURITY
-- =============================================================
-- Public anon client needs to:
--   - insert users, submissions, answers
--   - read polls, questions, question_options (to render poll)
--   - read aggregates for dashboard (users, submissions, answers, questions, options)
--
-- For stricter production use, gate the dashboard behind an
-- admin passcode (see README "Security") or move aggregation
-- into a Postgres function with security definer.
-- =============================================================

alter table public.users            enable row level security;
alter table public.polls            enable row level security;
alter table public.questions        enable row level security;
alter table public.question_options enable row level security;
alter table public.submissions      enable row level security;
alter table public.answers          enable row level security;

-- Read policies (dashboard + poll rendering)
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

-- Insert policies (anon can submit polls)
drop policy if exists "insert users"       on public.users;
drop policy if exists "insert submissions" on public.submissions;
drop policy if exists "insert answers"     on public.answers;

create policy "insert users"       on public.users       for insert with check (true);
create policy "insert submissions" on public.submissions for insert with check (true);
create policy "insert answers"     on public.answers     for insert with check (true);

-- =============================================================
-- SEED DATA - default poll + 6 questions, each with Yes/Not Sure/No
-- =============================================================
insert into public.polls (slug, title, description)
values (
  'swift-poll-default',
  'Does your learning system...',
  'Quick pulse-check on personalised learning readiness.'
)
on conflict (slug) do nothing;

-- Insert questions + options in a single PL/pgSQL block so ids
-- are wired together correctly.
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
    -- Skip if a question with the same text already exists for this poll
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
-- OPTIONAL: aggregate view for dashboard (convenience)
-- =============================================================
create or replace view public.v_question_option_counts as
select
  q.id          as question_id,
  q.question_text,
  q.display_order as question_order,
  o.id          as option_id,
  o.option_text,
  o.option_value,
  o.display_order as option_order,
  count(a.id)::int as response_count
from public.questions q
join public.question_options o on o.question_id = q.id
left join public.answers a on a.selected_option_id = o.id
where q.is_active = true
group by q.id, q.question_text, q.display_order, o.id, o.option_text, o.option_value, o.display_order
order by q.display_order, o.display_order;
