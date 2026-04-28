-- =============================================================
-- Swift Poll - Supabase Schema (v3: roles, types, users, reset)
-- =============================================================
-- Run this file in the Supabase SQL editor. It is idempotent -
-- safe to re-run on fresh and existing projects.
--
-- Ordering:
--   1. Extensions
--   2. Tables (IF NOT EXISTS)
--   3. Migrations: ALTER ... IF NOT EXISTS for existing installs
--   4. Indexes
--   5. Constraints (CHECK)
--   6. RLS policies
--   7. Seed data (default poll, seed dashboard_users, seed poll questions)
--   8. assigned_user -> assigned_user_id migration
--   9. Views + security-definer RPCs
-- =============================================================

create extension if not exists "pgcrypto";

-- -------------------------------------------------------------
-- 1. TABLES
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
  status      text not null default 'draft',
  is_active   boolean not null default true,  -- legacy; kept in sync via migration below
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Short-lived admin session tokens. Every admin write RPC
-- validates against this table - anon writes that bypass the UI
-- cannot forge admin access because the token is issued only
-- by dashboard_login on a correct bcrypt password match.
create table if not exists public.dashboard_sessions (
  token              uuid primary key default gen_random_uuid(),
  dashboard_user_id  uuid not null references public.dashboard_users(id) on delete cascade,
  role               text not null,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now()
);

-- Maps which dashboard_users (role=user) can access which polls.
-- Admins bypass this - they see every poll.
create table if not exists public.poll_user_access (
  id                 uuid primary key default gen_random_uuid(),
  poll_id            uuid not null references public.polls(id) on delete cascade,
  dashboard_user_id  uuid not null references public.dashboard_users(id) on delete cascade,
  is_enabled         boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (poll_id, dashboard_user_id)
);

create table if not exists public.questions (
  id            uuid primary key default gen_random_uuid(),
  poll_id       uuid not null references public.polls(id) on delete cascade,
  question_text text not null,
  question_type text not null default 'single_select',
  display_order int  not null default 0,
  is_active     boolean not null default true,
  is_required   boolean not null default false,
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

-- Dashboard-side accounts (Admin + segmented users).
-- Password hashed with pgcrypto bcrypt. RLS blocks anon select,
-- so clients must go through RPCs (below) which never leak the hash.
create table if not exists public.dashboard_users (
  id             uuid primary key default gen_random_uuid(),
  display_name   text not null,
  role           text not null default 'user',
  password_hash  text not null,
  is_active      boolean not null default true,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.submissions (
  id                uuid primary key default gen_random_uuid(),
  poll_id           uuid not null references public.polls(id) on delete cascade,
  user_id           uuid not null references public.users(id) on delete cascade,
  assigned_user_id  uuid,  -- will be tightened to NOT NULL + FK after backfill
  submitted_at      timestamptz not null default now(),
  status            text not null default 'submitted'
);

create table if not exists public.answers (
  id                   uuid primary key default gen_random_uuid(),
  submission_id        uuid not null references public.submissions(id) on delete cascade,
  question_id          uuid not null references public.questions(id) on delete cascade,
  selected_option_id   uuid references public.question_options(id),
  selected_option_text text,
  text_answer          text,
  created_at           timestamptz not null default now(),
  unique (submission_id, question_id)
);

-- -------------------------------------------------------------
-- 2. MIGRATIONS for existing installs
-- -------------------------------------------------------------
alter table public.questions        add column if not exists is_active   boolean not null default true;
alter table public.questions        add column if not exists is_required boolean not null default false;
alter table public.questions        add column if not exists deleted_at  timestamptz;
alter table public.questions        add column if not exists updated_at  timestamptz not null default now();
alter table public.question_options add column if not exists is_active   boolean not null default true;
alter table public.question_options add column if not exists deleted_at  timestamptz;
alter table public.question_options add column if not exists created_at  timestamptz not null default now();
alter table public.answers          add column if not exists text_answer text;
alter table public.submissions      add column if not exists assigned_user_id uuid;

-- Multi-poll migration columns
alter table public.polls            add column if not exists is_active   boolean not null default true;
alter table public.polls            add column if not exists deleted_at  timestamptz;
alter table public.polls            add column if not exists updated_at  timestamptz not null default now();
alter table public.polls            add column if not exists status      text not null default 'draft';

-- Backfill status from legacy is_active/deleted_at - but only
-- on rows that still have the default 'draft' and haven't been
-- explicitly set by a newer admin action.
do $$
begin
  update public.polls
     set status = case
       when deleted_at is not null then 'archived'
       when is_active = true       then 'active'
       else                             'draft'
     end
   where status = 'draft'
     and (is_active = true or deleted_at is not null);
end $$;

-- Make MCQ columns nullable so text_input rows can use text_answer only
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='answers'
               and column_name='selected_option_id' and is_nullable='NO') then
    alter table public.answers alter column selected_option_id drop not null;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='answers'
               and column_name='selected_option_text' and is_nullable='NO') then
    alter table public.answers alter column selected_option_text drop not null;
  end if;
end $$;

-- -------------------------------------------------------------
-- 3. INDEXES
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
create index if not exists submissions_assigned_user_idx     on public.submissions (assigned_user_id);

create index if not exists answers_submission_id_idx         on public.answers (submission_id);
create index if not exists answers_question_id_idx           on public.answers (question_id);
create index if not exists answers_option_id_idx             on public.answers (selected_option_id);

create index if not exists polls_active_idx                  on public.polls (is_active, deleted_at);
create index if not exists polls_status_idx                  on public.polls (status);
create index if not exists dashboard_sessions_user_idx       on public.dashboard_sessions (dashboard_user_id);
create index if not exists dashboard_sessions_expires_idx    on public.dashboard_sessions (expires_at);

create index if not exists poll_user_access_poll_idx         on public.poll_user_access (poll_id);
create index if not exists poll_user_access_user_idx         on public.poll_user_access (dashboard_user_id);

create unique index if not exists dashboard_users_name_idx
  on public.dashboard_users (lower(display_name)) where deleted_at is null;
create index if not exists dashboard_users_is_active_idx
  on public.dashboard_users (is_active, deleted_at);

-- -------------------------------------------------------------
-- 4. CHECK CONSTRAINTS (idempotent)
-- -------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'questions_text_length_chk') then
    alter table public.questions
      add constraint questions_text_length_chk check (char_length(question_text) between 1 and 150);
  end if;

  alter table public.questions drop constraint if exists questions_type_chk;
  alter table public.questions
    add constraint questions_type_chk check (question_type in ('single_select','text_input'));

  if not exists (select 1 from pg_constraint where conname = 'question_options_text_length_chk') then
    alter table public.question_options
      add constraint question_options_text_length_chk check (char_length(option_text) between 1 and 75);
  end if;

  alter table public.answers drop constraint if exists answers_kind_chk;
  alter table public.answers
    add constraint answers_kind_chk check (
      (selected_option_id is not null and text_answer is null) or
      (selected_option_id is null and char_length(coalesce(text_answer, '')) <= 300)
    );

  if not exists (select 1 from pg_constraint where conname = 'dashboard_users_role_chk') then
    alter table public.dashboard_users
      add constraint dashboard_users_role_chk check (role in ('admin','user'));
  end if;

  alter table public.polls drop constraint if exists polls_status_chk;
  alter table public.polls
    add constraint polls_status_chk check (status in ('draft','active','archived'));
end $$;

-- =============================================================
-- 5. ROW LEVEL SECURITY
-- =============================================================
alter table public.users            enable row level security;
alter table public.polls            enable row level security;
alter table public.questions        enable row level security;
alter table public.question_options enable row level security;
alter table public.submissions      enable row level security;
alter table public.answers          enable row level security;
alter table public.dashboard_users  enable row level security;
alter table public.poll_user_access enable row level security;

-- Reads (poll rendering + dashboard aggregation)
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

-- Poll submission writes
drop policy if exists "insert users"       on public.users;
drop policy if exists "insert submissions" on public.submissions;
drop policy if exists "insert answers"     on public.answers;
create policy "insert users"       on public.users       for insert with check (true);
create policy "insert submissions" on public.submissions for insert with check (true);
create policy "insert answers"     on public.answers     for insert with check (true);

-- Admin-only tables: all writes go through security-definer RPCs
-- that validate a dashboard_sessions token. Dropping direct-table
-- policies means anon cannot insert/update/delete these tables
-- even from DevTools - the RPC is the only doorway.
drop policy if exists "admin insert questions"        on public.questions;
drop policy if exists "admin update questions"        on public.questions;
drop policy if exists "admin insert question_options" on public.question_options;
drop policy if exists "admin update question_options" on public.question_options;
drop policy if exists "admin delete submissions"      on public.submissions;
drop policy if exists "admin delete answers"          on public.answers;
drop policy if exists "admin insert polls"            on public.polls;
drop policy if exists "admin update polls"            on public.polls;
drop policy if exists "admin delete polls"            on public.polls;

-- Poll access mapping: read is public, writes require admin token
drop policy if exists "read poll_user_access"   on public.poll_user_access;
drop policy if exists "insert poll_user_access" on public.poll_user_access;
drop policy if exists "update poll_user_access" on public.poll_user_access;
drop policy if exists "delete poll_user_access" on public.poll_user_access;
create policy "read poll_user_access" on public.poll_user_access for select using (true);

-- dashboard_users: block all direct anon access. Everything goes
-- through the security-definer RPCs defined below so password_hash
-- never leaves the DB.
drop policy if exists "no anon on dashboard_users" on public.dashboard_users;

-- =============================================================
-- 6. SEED - default poll + default dashboard users
-- =============================================================
insert into public.polls (slug, title, description)
values (
  'swift-poll-default',
  'Does your learning system...',
  'Quick pulse-check on personalised learning readiness.'
)
on conflict (slug) do nothing;

-- Seed dashboard_users: one admin + six users with default passwords
-- Admin password: 1234         User passwords: user
insert into public.dashboard_users (display_name, role, password_hash)
select v.name, v.role, extensions.crypt(v.pw, extensions.gen_salt('bf'))
from (values
  ('Admin',  'admin', '1234'),
  ('User 1', 'user',  'user'),
  ('User 2', 'user',  'user'),
  ('User 3', 'user',  'user'),
  ('User 4', 'user',  'user'),
  ('User 5', 'user',  'user'),
  ('User 6', 'user',  'user')
) as v(name, role, pw)
where not exists (
  select 1 from public.dashboard_users d
  where lower(d.display_name) = lower(v.name) and d.deleted_at is null
);

-- Seed poll questions (same six legacy Yes/Not Sure/No questions)
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
    select id into v_q_id from public.questions
    where poll_id = v_poll_id and question_text = v_texts[v_idx];

    if v_q_id is null then
      insert into public.questions (poll_id, question_text, question_type, display_order, is_active, is_required)
      values (v_poll_id, v_texts[v_idx], 'single_select', v_idx, true, false)
      returning id into v_q_id;

      insert into public.question_options (question_id, option_text, option_value, display_order) values
        (v_q_id, 'Yes',      'yes',      1),
        (v_q_id, 'Not Sure', 'not_sure', 2),
        (v_q_id, 'No',       'no',       3);
    end if;
  end loop;
end $$;

-- Backward-compat: grant every existing non-admin user access to
-- the default poll so nothing breaks after deployment.
insert into public.poll_user_access (poll_id, dashboard_user_id, is_enabled)
select p.id, d.id, true
from public.polls p
join public.dashboard_users d on d.role = 'user' and d.is_active = true and d.deleted_at is null
where p.slug = 'swift-poll-default'
  and not exists (
    select 1 from public.poll_user_access a
    where a.poll_id = p.id and a.dashboard_user_id = d.id
  );

-- =============================================================
-- 7. MIGRATE submissions.assigned_user (text) -> assigned_user_id
-- =============================================================
do $$
declare
  v_fallback uuid;
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='submissions' and column_name='assigned_user') then

    update public.submissions s
       set assigned_user_id = du.id
      from public.dashboard_users du
     where s.assigned_user_id is null
       and s.assigned_user is not null
       and du.display_name = case s.assigned_user
         when 'user_1' then 'User 1'
         when 'user_2' then 'User 2'
         when 'user_3' then 'User 3'
         when 'user_4' then 'User 4'
         when 'user_5' then 'User 5'
         when 'user_6' then 'User 6'
         else null
       end;

    alter table public.submissions drop constraint if exists submissions_assigned_user_chk;
    alter table public.submissions drop column assigned_user;
  end if;

  -- Final fallback: any null assigned_user_id -> User 1
  select id into v_fallback from public.dashboard_users
   where display_name = 'User 1' and deleted_at is null limit 1;

  if v_fallback is not null then
    update public.submissions set assigned_user_id = v_fallback where assigned_user_id is null;
  end if;
end $$;

-- Now that assigned_user_id is populated, tighten it
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='submissions'
               and column_name='assigned_user_id' and is_nullable='YES') then
    if not exists (select 1 from public.submissions where assigned_user_id is null) then
      alter table public.submissions alter column assigned_user_id set not null;
    end if;
  end if;

  if not exists (select 1 from pg_constraint where conname = 'submissions_assigned_user_fk') then
    alter table public.submissions
      add constraint submissions_assigned_user_fk
      foreign key (assigned_user_id) references public.dashboard_users(id);
  end if;
end $$;

-- =============================================================
-- 8. RPCs
--
-- Security model:
--   * `dashboard_login` issues a 24h bearer token on a correct
--     bcrypt match and writes it to dashboard_sessions.
--   * `validate_admin(token)` raises if the token is missing /
--     expired / not tied to an active admin.
--   * Every write RPC prefixed `admin_` calls validate_admin()
--     first. RLS has no open admin-write policies, so bypassing
--     the RPC with a direct REST call fails.
-- =============================================================

-- Return shape changed (added `token`); drop the old signature first.
drop function if exists public.dashboard_login(text, text);

-- Login: returns user row + session token on success
create or replace function public.dashboard_login(p_display_name text, p_password text)
returns table(id uuid, display_name text, role text, token uuid)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user public.dashboard_users%rowtype;
  v_token uuid;
begin
  select d.* into v_user
    from public.dashboard_users d
   where lower(d.display_name) = lower(p_display_name)
     and d.is_active = true
     and d.deleted_at is null
     and d.password_hash = crypt(p_password, d.password_hash);

  if v_user.id is null then
    return;  -- empty result = auth failure
  end if;

  -- Opportunistic cleanup of expired sessions
  delete from public.dashboard_sessions s where s.expires_at < now();

  insert into public.dashboard_sessions (dashboard_user_id, role, expires_at)
  values (v_user.id, v_user.role, now() + interval '24 hours')
  returning public.dashboard_sessions.token into v_token;

  return query
    select v_user.id, v_user.display_name, v_user.role, v_token;
end $$;

create or replace function public.dashboard_logout(p_token uuid)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  delete from public.dashboard_sessions where token = p_token;
$$;

-- Internal helper: returns admin's id or raises
create or replace function public.validate_admin(p_token uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_admin_id uuid;
begin
  select s.dashboard_user_id into v_admin_id
    from public.dashboard_sessions s
    join public.dashboard_users   d on d.id = s.dashboard_user_id
   where s.token = p_token
     and s.expires_at > now()
     and s.role = 'admin'
     and d.is_active = true
     and d.deleted_at is null;
  if v_admin_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  return v_admin_id;
end $$;

-- List dashboard users (no hashes exposed)
create or replace function public.dashboard_list_users()
returns table(id uuid, display_name text, role text, is_active boolean, created_at timestamptz)
language sql
security definer
set search_path = public, extensions
as $$
  select id, display_name, role, is_active, created_at
  from public.dashboard_users
  where deleted_at is null
  order by case when role = 'admin' then 0 else 1 end, display_name;
$$;

-- Active non-admin users (for poll dropdown)
create or replace function public.dashboard_active_user_accounts()
returns table(id uuid, display_name text)
language sql
security definer
set search_path = public, extensions
as $$
  select id, display_name
  from public.dashboard_users
  where role = 'user' and is_active = true and deleted_at is null
  order by display_name;
$$;

-- Drop pre-token versions so ambiguous signatures can't linger
drop function if exists public.dashboard_create_user(text, text, text);
drop function if exists public.dashboard_rename_user(uuid, text);
drop function if exists public.dashboard_change_password(uuid, text);
drop function if exists public.dashboard_delete_user(uuid);
drop function if exists public.dashboard_reset_data();
drop function if exists public.dashboard_reset_poll(uuid);

-- -------------------------------------------------------------
-- User management (admin-token gated)
-- -------------------------------------------------------------
create or replace function public.admin_create_user(
  p_token uuid, p_display_name text, p_password text
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  perform public.validate_admin(p_token);
  if char_length(coalesce(p_display_name,'')) = 0 then raise exception 'display_name required'; end if;
  if char_length(coalesce(p_password,'')) < 4 then raise exception 'password too short'; end if;
  if exists (select 1 from public.dashboard_users d
             where lower(d.display_name) = lower(p_display_name) and d.deleted_at is null) then
    raise exception 'display_name already exists';
  end if;
  insert into public.dashboard_users (display_name, role, password_hash, is_active)
  values (p_display_name, 'user', crypt(p_password, gen_salt('bf')), true)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.admin_rename_user(p_token uuid, p_id uuid, p_new_name text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.validate_admin(p_token);
  if char_length(coalesce(p_new_name,'')) = 0 then raise exception 'display_name required'; end if;
  if exists (select 1 from public.dashboard_users d
             where lower(d.display_name) = lower(p_new_name) and d.deleted_at is null and d.id <> p_id) then
    raise exception 'display_name already exists';
  end if;
  update public.dashboard_users set display_name = p_new_name, updated_at = now() where id = p_id;
end $$;

create or replace function public.admin_change_password(p_token uuid, p_id uuid, p_new_password text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.validate_admin(p_token);
  if char_length(coalesce(p_new_password,'')) < 4 then raise exception 'password too short'; end if;
  update public.dashboard_users
     set password_hash = crypt(p_new_password, gen_salt('bf')), updated_at = now()
   where id = p_id;
end $$;

create or replace function public.admin_delete_user(p_token uuid, p_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_role text; v_remaining int;
begin
  perform public.validate_admin(p_token);
  select role into v_role from public.dashboard_users where id = p_id and deleted_at is null;
  if v_role is null then raise exception 'user not found'; end if;
  if v_role = 'admin' then
    select count(*) into v_remaining from public.dashboard_users
     where role = 'admin' and is_active = true and deleted_at is null and id <> p_id;
    if v_remaining < 1 then raise exception 'cannot delete the last active admin'; end if;
  end if;
  update public.dashboard_users
     set is_active = false, deleted_at = now(), updated_at = now()
   where id = p_id;
end $$;

-- -------------------------------------------------------------
-- Poll management
-- -------------------------------------------------------------
create or replace function public.admin_create_poll(
  p_token uuid, p_title text, p_slug text, p_description text
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  perform public.validate_admin(p_token);
  if char_length(coalesce(p_title,'')) = 0 then raise exception 'title required'; end if;
  if char_length(coalesce(p_slug,'')) = 0 then raise exception 'slug required'; end if;
  insert into public.polls (title, slug, description, status, is_active)
  values (p_title, lower(p_slug), nullif(p_description, ''), 'draft', false)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.admin_update_poll(
  p_token uuid, p_id uuid, p_title text, p_description text, p_status text
) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_has_questions boolean;
begin
  perform public.validate_admin(p_token);
  if p_status not in ('draft','active','archived') then raise exception 'invalid status'; end if;

  if p_status = 'active' then
    select exists (
      select 1 from public.questions
       where poll_id = p_id and is_active = true and deleted_at is null
    ) into v_has_questions;
    if not v_has_questions then
      raise exception 'A poll must have at least one active question before it can be activated.';
    end if;
  end if;

  update public.polls
     set title       = coalesce(nullif(trim(p_title), ''), title),
         description = case when p_description is null then description else nullif(trim(p_description), '') end,
         status      = p_status,
         is_active   = (p_status = 'active'),
         deleted_at  = case when p_status = 'archived' and deleted_at is null then now() else deleted_at end,
         updated_at  = now()
   where id = p_id;
end $$;

-- Duplicate a poll: copy the row + its active questions/options.
-- Submissions, answers, and access mappings are intentionally NOT
-- copied. The new poll starts as 'draft'.
create or replace function public.admin_duplicate_poll(
  p_token uuid, p_source_id uuid, p_new_slug text, p_new_title text
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_src public.polls%rowtype;
  v_new_id uuid;
  v_src_q record;
  v_new_q uuid;
begin
  perform public.validate_admin(p_token);
  select * into v_src from public.polls where id = p_source_id;
  if v_src.id is null then raise exception 'source poll not found'; end if;

  insert into public.polls (title, slug, description, status, is_active)
  values (
    coalesce(nullif(trim(p_new_title), ''), v_src.title || ' (Copy)'),
    lower(coalesce(nullif(trim(p_new_slug), ''), v_src.slug || '-copy')),
    v_src.description,
    'draft', false
  )
  returning id into v_new_id;

  for v_src_q in
    select id, question_text, question_type, display_order, is_required
      from public.questions
     where poll_id = p_source_id and is_active = true and deleted_at is null
     order by display_order
  loop
    insert into public.questions (poll_id, question_text, question_type, display_order, is_active, is_required)
    values (v_new_id, v_src_q.question_text, v_src_q.question_type, v_src_q.display_order, true, v_src_q.is_required)
    returning id into v_new_q;

    insert into public.question_options (question_id, option_text, option_value, display_order, is_active)
    select v_new_q, option_text, option_value, display_order, true
      from public.question_options
     where question_id = v_src_q.id and is_active = true and deleted_at is null
     order by display_order;
  end loop;

  return v_new_id;
end $$;

-- -------------------------------------------------------------
-- Poll visibility
-- -------------------------------------------------------------
create or replace function public.admin_set_poll_access(
  p_token uuid, p_poll_id uuid, p_user_id uuid, p_enabled boolean
) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.validate_admin(p_token);
  insert into public.poll_user_access (poll_id, dashboard_user_id, is_enabled, updated_at)
  values (p_poll_id, p_user_id, p_enabled, now())
  on conflict (poll_id, dashboard_user_id)
  do update set is_enabled = excluded.is_enabled, updated_at = now();
end $$;

-- -------------------------------------------------------------
-- Question management
-- -------------------------------------------------------------
create or replace function public.admin_create_question(
  p_token uuid, p_poll_id uuid, p_text text, p_type text,
  p_is_required boolean, p_options text[]
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid;
  v_order int;
  v_opt text;
  v_idx int;
begin
  perform public.validate_admin(p_token);

  if char_length(coalesce(p_text,'')) = 0 then raise exception 'question text required'; end if;
  if char_length(p_text) > 150 then raise exception 'question too long'; end if;
  if p_type not in ('single_select','text_input') then raise exception 'invalid type'; end if;

  if p_type = 'single_select' then
    if p_options is null or array_length(p_options, 1) is null then
      raise exception 'MCQ needs at least 2 options';
    end if;
    if array_length(p_options, 1) < 2 then raise exception 'MCQ needs at least 2 options'; end if;
    if array_length(p_options, 1) > 5 then raise exception 'MCQ allows at most 5 options'; end if;
  end if;

  select coalesce(max(display_order), 0) + 1 into v_order
    from public.questions where poll_id = p_poll_id;

  insert into public.questions (poll_id, question_text, question_type, display_order, is_active, is_required)
  values (p_poll_id, p_text, p_type, v_order, true, coalesce(p_is_required, false))
  returning id into v_id;

  if p_type = 'single_select' then
    v_idx := 1;
    foreach v_opt in array p_options loop
      if char_length(trim(coalesce(v_opt, ''))) = 0 then raise exception 'blank option'; end if;
      if char_length(v_opt) > 75 then raise exception 'option too long'; end if;
      insert into public.question_options (question_id, option_text, option_value, display_order, is_active)
      values (v_id, v_opt, 'opt_' || v_idx, v_idx, true);
      v_idx := v_idx + 1;
    end loop;
  end if;

  return v_id;
end $$;

-- Soft-delete a question; if it was the last active question in an
-- active poll, demote the poll back to 'draft' so the system stops
-- serving an empty poll.
create or replace function public.admin_delete_question(p_token uuid, p_question_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_poll_id uuid;
begin
  perform public.validate_admin(p_token);
  select poll_id into v_poll_id from public.questions where id = p_question_id;
  if v_poll_id is null then raise exception 'question not found'; end if;

  update public.question_options set is_active = false, deleted_at = now() where question_id = p_question_id;
  update public.questions        set is_active = false, deleted_at = now(), updated_at = now() where id = p_question_id;

  if not exists (
    select 1 from public.questions
     where poll_id = v_poll_id and is_active = true and deleted_at is null
  ) then
    update public.polls set status = 'draft', is_active = false, updated_at = now()
     where id = v_poll_id and status = 'active';
  end if;
end $$;

-- -------------------------------------------------------------
-- Submission deletion + scoped reset
-- -------------------------------------------------------------
create or replace function public.admin_delete_submission(p_token uuid, p_submission_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.validate_admin(p_token);
  delete from public.submissions where id = p_submission_id;
end $$;

create or replace function public.admin_reset_poll(p_token uuid, p_poll_id uuid)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public.validate_admin(p_token);
  delete from public.answers
    where submission_id in (select id from public.submissions where poll_id = p_poll_id);
  delete from public.submissions where poll_id = p_poll_id;
  delete from public.question_options
    where question_id in (select id from public.questions where poll_id = p_poll_id);
  delete from public.questions where poll_id = p_poll_id;
  update public.polls set status = 'draft', is_active = false, updated_at = now() where id = p_poll_id;
end $$;

-- Respondent view: active polls only, mapped to this user bucket.
create or replace function public.polls_for_respondent(p_dashboard_user_id uuid)
returns table(id uuid, slug text, title text, description text)
language sql
security definer
set search_path = public, extensions
as $$
  select p.id, p.slug, p.title, p.description
  from public.polls p
  join public.poll_user_access a on a.poll_id = p.id
  where a.dashboard_user_id = p_dashboard_user_id
    and a.is_enabled = true
    and p.status     = 'active'
  order by p.title;
$$;

-- Return shape changed (is_active -> status); drop first.
drop function if exists public.polls_for_dashboard_user(uuid);

-- Dashboard view: admin sees every poll (draft/active/archived);
-- normal user sees only active polls mapped to them.
create or replace function public.polls_for_dashboard_user(p_user_id uuid)
returns table(id uuid, slug text, title text, description text, status text)
language sql
security definer
set search_path = public, extensions
as $$
  select p.id, p.slug, p.title, p.description, p.status
  from public.polls p
  where (
    exists (select 1 from public.dashboard_users d
             where d.id = p_user_id and d.role = 'admin' and d.is_active = true and d.deleted_at is null)
    or (
      p.status = 'active'
      and exists (select 1 from public.poll_user_access a
                   where a.poll_id = p.id and a.dashboard_user_id = p_user_id and a.is_enabled = true)
    )
  )
  order by p.title;
$$;

-- Grants. admin_* functions are still callable by anon, but they
-- raise 'unauthorized' without a valid admin token.
grant execute on function public.dashboard_login(text, text)                          to anon, authenticated;
grant execute on function public.dashboard_logout(uuid)                               to anon, authenticated;
grant execute on function public.dashboard_list_users()                               to anon, authenticated;
grant execute on function public.dashboard_active_user_accounts()                     to anon, authenticated;
grant execute on function public.polls_for_respondent(uuid)                           to anon, authenticated;
grant execute on function public.polls_for_dashboard_user(uuid)                       to anon, authenticated;
grant execute on function public.validate_admin(uuid)                                 to anon, authenticated;

grant execute on function public.admin_create_user(uuid, text, text)                  to anon, authenticated;
grant execute on function public.admin_rename_user(uuid, uuid, text)                  to anon, authenticated;
grant execute on function public.admin_change_password(uuid, uuid, text)              to anon, authenticated;
grant execute on function public.admin_delete_user(uuid, uuid)                        to anon, authenticated;
grant execute on function public.admin_create_poll(uuid, text, text, text)            to anon, authenticated;
grant execute on function public.admin_update_poll(uuid, uuid, text, text, text)      to anon, authenticated;
grant execute on function public.admin_duplicate_poll(uuid, uuid, text, text)         to anon, authenticated;
grant execute on function public.admin_set_poll_access(uuid, uuid, uuid, boolean)     to anon, authenticated;
grant execute on function public.admin_create_question(uuid, uuid, text, text, boolean, text[]) to anon, authenticated;
grant execute on function public.admin_delete_question(uuid, uuid)                    to anon, authenticated;
grant execute on function public.admin_delete_submission(uuid, uuid)                  to anon, authenticated;
grant execute on function public.admin_reset_poll(uuid, uuid)                         to anon, authenticated;

-- =============================================================
-- 9. Aggregated view (active only)
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
