-- teadio — schema, authorization and queue.
--
-- Runs on vanilla Postgres 15+ (so the policy suite is runnable anywhere) and on
-- Neon with the Data API enabled (production). Load it once, in order:
--
--   psql "$DATABASE_URL" -f db/schema.sql
--
-- The database is the message broker AND the only authorization layer. There is
-- no server-side data tier: the browser talks to Postgres over the Data API with
-- a Clerk JWT, and workers connect directly as `teadio_worker`.

begin;

create schema if not exists teadio;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- `authenticated` / `anonymous` are created by Neon when the Data API is
-- enabled; created here too so this file loads on a bare Postgres.
--
-- `teadio_worker` is NOLOGIN on purpose. Create a real login role per
-- deployment and grant this one to it:
--   create role teadio_w1 login password '...'; grant teadio_worker to teadio_w1;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'anonymous') then
    create role anonymous nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'teadio_worker') then
    create role teadio_worker nologin;
  end if;
end $$;

grant usage on schema public, teadio to authenticated, teadio_worker;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

-- The signed-in user's id (Clerk `sub`), or NULL.
--
-- Dynamic EXECUTE so this file loads where pg_session_jwt is absent — that is
-- what lets db/test_rls.sql run on a throwaway Postgres with no Neon account.
--
-- The session-GUC fallback is gated on the ABSENCE of auth.user_id(), not on
-- the current role: a SECURITY DEFINER function runs as the table owner, so a
-- role-based guard would quietly open the fallback inside exactly the functions
-- that matter most. Wherever the Data API is serving requests the extension is
-- installed, so the JWT is the only identity that can ever be produced.
create or replace function teadio.uid() returns text
language plpgsql stable
as $$
declare v text; has_jwt boolean;
begin
  begin
    execute 'select auth.user_id()' into v;
    has_jwt := true;
  exception
    when undefined_function or invalid_schema_name then
      has_jwt := false;                      -- bare Postgres: test harness only
    when others then
      has_jwt := true; v := null;            -- extension present, no valid token
  end;

  if has_jwt then return v; end if;
  return nullif(current_setting('teadio.test_uid', true), '');
end $$;

-- The signed-in user's email, ONLY if the provider says it is verified.
--
-- Membership is keyed by user id, not email — but invitations are keyed by
-- email so you can invite someone before they sign up. An unverified address is
-- an unproven claim, and a member can queue a job that runs code on a
-- colleague's laptop, so redemption requires the verified claim and silently
-- does nothing without it.
--
-- Clerk: add `email` and `email_verified` to the JWT template. Without them
-- this returns NULL and invitations simply never redeem (fails closed).
create or replace function teadio.verified_email() returns text
language plpgsql stable
as $$
declare claims jsonb; has_jwt boolean;
begin
  begin
    execute 'select auth.session()' into claims;
    has_jwt := true;
  exception
    when undefined_function or invalid_schema_name then
      has_jwt := false;
    when others then
      has_jwt := true; claims := null;
  end;

  -- PostgREST sets this GUC from the verified token; harmless if unset.
  if claims is null then
    claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
    if claims is not null then has_jwt := true; end if;
  end if;

  if claims is not null then
    if coalesce((claims ->> 'email_verified')::boolean, false) then
      return lower(claims ->> 'email');
    end if;
    return null;
  end if;

  if has_jwt then return null; end if;
  return nullif(lower(current_setting('teadio.test_email', true)), '');
end $$;

-- ---------------------------------------------------------------------------
-- Shared constants
-- ---------------------------------------------------------------------------

-- How long a worker may go unheard-from before it is presumed dead. Defined
-- ONCE: the liveness view and the stale sweep both call it, so "online" in the
-- console and "reclaimable" in the sweep can never drift apart.
create or replace function teadio.stale_after() returns interval
language sql immutable as $$ select interval '45 seconds' $$;

create or replace function teadio.touch() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One row per worker PROCESS. A laptop running three slots has three rows that
-- share a `machine`. Jobs pin to a machine, never to a hostname.
create table workers (
  id            uuid primary key default gen_random_uuid(),
  hostname      text not null unique,
  machine       text not null,
  owner_id      text,                                  -- whose laptop this is
  capabilities  jsonb not null default '{}'::jsonb,    -- {cores,ram_gb,free_disk_gb,arch}
  version       text,
  paused        boolean not null default false,        -- the laptop owner's "not now"
  last_seen     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

-- Liveness is computed from the DATABASE clock. Never from the browser's — that
-- would make the viewer's laptop clock the arbiter of fleet health.
create view worker_status with (security_invoker = true) as
  select id, hostname, machine, owner_id, capabilities, version, paused, last_seen,
         (now() - last_seen) < teadio.stale_after() as online
    from workers;

create table projects (
  id          uuid primary key default gen_random_uuid(),
  -- This regex is the AUTHORITATIVE slug rule. The console must not re-implement
  -- it — let the insert fail and surface the error, or three regexes drift and
  -- one combination passes two of them and is rejected by the third.
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name        text not null,
  repo_url    text,                                    -- the team's Remotion project
  created_at  timestamptz not null default now()
);

create table project_members (
  project_id  uuid not null references projects(id) on delete cascade,
  user_id     text not null,
  role        text not null default 'member' check (role in ('owner', 'member')),
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);

create table project_invites (
  project_id  uuid not null references projects(id) on delete cascade,
  email       text not null check (email = lower(email)),
  role        text not null default 'member' check (role in ('owner', 'member')),
  invited_by  text not null,
  created_at  timestamptz not null default now(),
  primary key (project_id, email)
);

create table jobs (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects(id) on delete cascade,
  slug              text not null check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  -- One queue serves both job types; the worker branches. Cheaper than a second
  -- table by a mile.
  kind              text not null check (kind in ('render', 'generate')),
  profile           text,                              -- output profile (prose, not code)

  -- No 'awaiting review'. A terminal state pretending not to be terminal breaks
  -- every filter in the console.
  status            text not null default 'pending'
                    check (status in ('pending','claimed','running','completed','failed','cancelled')),
  stage             text,                              -- the single most useful field
  stage_at          timestamptz,                       -- → time-in-stage, never a percentage
  resume_from_stage text,
  session_id        text,                              -- resume the agent, don't restart it

  -- Inputs. `composition_id` is an input for kind='render' and an output for
  -- kind='generate', hence nullable.
  composition_id    text,
  commit_sha        text,
  props             jsonb not null default '{}'::jsonb,
  brief             text,
  revision_of       uuid references jobs(id) on delete set null,
  feedback          text,

  -- Execution. NULL target_machine is the normal case: any idle laptop may take
  -- it. Only pin when the job genuinely needs a specific box's disk — a pinned
  -- job whose laptop never comes back can never be reclaimed elsewhere.
  target_machine    text,
  claimed_by        uuid references workers(id) on delete set null,
  attempts          int not null default 0,

  -- Outputs.
  artifact_url      text,
  artifact_bytes    bigint,
  render_seconds    numeric,
  frames            int,
  cost_usd          numeric(10,4) not null default 0,
  error             text,
  summary           jsonb,                             -- structured final summary, or the BLOCKED shape

  created_by        text not null default teadio.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  claimed_at        timestamptz,
  started_at        timestamptz,
  finished_at       timestamptz,

  -- A run that rendered but could not upload is not a success. Enforced here so
  -- no code path can mark a job done while its only copy is on a laptop.
  constraint jobs_completed_has_artifact
    check (status <> 'completed' or artifact_url is not null),
  -- A cheerful failure is worse than a loud one.
  constraint jobs_failed_has_error
    check (status <> 'failed' or error is not null)
);

create trigger jobs_touch before update on jobs
  for each row execute function teadio.touch();

-- The claim path. Partial + ordered so claiming stays a single index hit.
create index jobs_pending on jobs (created_at) where status = 'pending';
create index jobs_by_project on jobs (project_id, created_at desc);
create index jobs_by_worker on jobs (claimed_by) where status in ('claimed', 'running');

-- Stops two runs fighting over the same working directory. `kind` is included
-- because different job types own different directories.
create unique index jobs_one_live on jobs (project_id, kind, slug)
  where status in ('pending', 'claimed', 'running');

create table job_files (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references jobs(id) on delete cascade,
  filename     text not null,
  content_type text,
  bytes        bigint,
  storage_key  text not null,                          -- R2 object key
  created_at   timestamptz not null default now()
);
create index job_files_by_job on job_files (job_id);

-- Append-only: the live log and the audit trail. No UPDATE or DELETE policy
-- exists for anyone.
create table job_events (
  id      bigint generated always as identity primary key,
  job_id  uuid not null references jobs(id) on delete cascade,
  at      timestamptz not null default now(),
  level   text not null default 'info' check (level in ('info', 'warn', 'error', 'stage')),
  stage   text,
  message text not null
);
create index job_events_by_job on job_events (job_id, id);

-- ---------------------------------------------------------------------------
-- Membership helpers
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so a policy on project_members does not recurse into itself
-- when it is the very table being filtered.

create or replace function teadio.is_member(p_project uuid) returns boolean
language sql stable security definer set search_path = public, teadio, pg_catalog
as $$
  select exists (
    select 1 from project_members m
     where m.project_id = p_project and m.user_id = teadio.uid())
$$;

create or replace function teadio.is_owner(p_project uuid) returns boolean
language sql stable security definer set search_path = public, teadio, pg_catalog
as $$
  select exists (
    select 1 from project_members m
     where m.project_id = p_project and m.user_id = teadio.uid() and m.role = 'owner')
$$;

create or replace function teadio.can_see_job(p_job uuid) returns boolean
language sql stable security definer set search_path = public, teadio, pg_catalog
as $$
  select teadio.is_member(j.project_id) from jobs j where j.id = p_job
$$;

-- ---------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------
-- Every worker write goes through one of these. They are SECURITY DEFINER and
-- `teadio_worker` has no UPDATE grant on any table, so a worker literally
-- cannot perform an unfenced write.
--
-- WARNING: these take defaulted parameters. Adding another one creates a SECOND
-- function beside the first rather than replacing it. Always DROP the old
-- signature explicitly and re-GRANT — grants name the full signature.

-- SKIP LOCKED is the load balancer. Two workers can never take the same job.
-- Returns the job id only; the worker then SELECTs it under its own column
-- grants, so this cannot leak `created_by` past those grants.
create or replace function teadio.claim_next(p_worker uuid, p_machine text)
returns uuid
language plpgsql security definer set search_path = public, teadio, pg_catalog
as $$
declare v_id uuid;
begin
  update jobs set
      status     = 'claimed',
      claimed_by = p_worker,
      claimed_at = now(),
      attempts   = attempts + 1
  where id = (
    select id from jobs
     where status = 'pending'
       and (target_machine is null or target_machine = p_machine)
     order by created_at
       for update skip locked
     limit 1
  )
  returning id into v_id;

  return v_id;
end $$;

-- Fenced progress write. Returns false — rather than raising — if this worker
-- no longer owns the job, which is exactly what a worker finishing late after
-- its heartbeat lapsed must see. Both workers would otherwise bill.
create or replace function teadio.job_progress(
  p_job uuid, p_worker uuid,
  p_stage text default null, p_level text default 'info', p_message text default null)
returns boolean
language plpgsql security definer set search_path = public, teadio, pg_catalog
as $$
declare n int;
begin
  update jobs set
      status     = 'running',
      stage      = coalesce(p_stage, stage),
      stage_at   = case when p_stage is not null and p_stage is distinct from stage
                        then now() else stage_at end,
      started_at = coalesce(started_at, now())
   where id = p_job and claimed_by = p_worker
     and status in ('claimed', 'running');
  get diagnostics n = row_count;
  if n = 0 then return false; end if;

  if p_message is not null then
    -- The worker redacts credential shapes and drops base64 runs before it gets
    -- here; this is only the backstop against one runaway line.
    insert into job_events (job_id, level, stage, message)
    values (p_job, coalesce(p_level, 'info'), p_stage, left(p_message, 8000));
  end if;
  return true;
end $$;

-- Fenced terminal write. The artifact is already in object storage by the time
-- this is called.
create or replace function teadio.job_finish(
  p_job uuid, p_worker uuid, p_status text,
  p_artifact_url text default null, p_artifact_bytes bigint default null,
  p_render_seconds numeric default null, p_frames int default null,
  p_cost_usd numeric default null, p_error text default null,
  p_summary jsonb default null)
returns boolean
language plpgsql security definer set search_path = public, teadio, pg_catalog
as $$
declare n int;
begin
  if p_status not in ('completed', 'failed') then
    raise exception 'job_finish: status must be completed or failed, got %', p_status;
  end if;

  update jobs set
      status         = p_status,
      artifact_url   = coalesce(p_artifact_url, artifact_url),
      artifact_bytes = coalesce(p_artifact_bytes, artifact_bytes),
      render_seconds = coalesce(p_render_seconds, render_seconds),
      frames         = coalesce(p_frames, frames),
      cost_usd       = coalesce(p_cost_usd, cost_usd),
      error          = case when p_status = 'failed'
                            then coalesce(p_error, error, 'failed without a stated reason')
                            else p_error end,
      summary        = coalesce(p_summary, summary),
      finished_at    = now()
   where id = p_job and claimed_by = p_worker
     and status in ('claimed', 'running');
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- Any worker sweeps on every poll; there is no separate cron to forget to run.
-- A job whose laptop closed its lid goes back to pending, and remembers the
-- stage it reached so the next worker resumes rather than restarts.
create or replace function teadio.release_stale_jobs(p_max_attempts int default 3)
returns int
language plpgsql security definer set search_path = public, teadio, pg_catalog
as $$
declare n int;
begin
  with stale as (
    select j.id, j.attempts >= p_max_attempts as exhausted
      from jobs j
      left join workers w on w.id = j.claimed_by
     where j.status in ('claimed', 'running')
       and (w.id is null or now() - w.last_seen > teadio.stale_after())
  )
  update jobs j set
      status            = case when s.exhausted then 'failed' else 'pending' end,
      error             = case when s.exhausted
                               then 'abandoned: worker vanished after '
                                    || j.attempts || ' attempt(s)' end,
      resume_from_stage = coalesce(j.stage, j.resume_from_stage),
      claimed_by        = null,
      claimed_at        = null,
      finished_at       = case when s.exhausted then now() end
    from stale s where j.id = s.id;

  get diagnostics n = row_count;
  return n;
end $$;

create or replace function teadio.worker_register(
  p_hostname text, p_machine text,
  p_owner_id text default null, p_capabilities jsonb default '{}'::jsonb,
  p_version text default null)
returns uuid
language plpgsql security definer set search_path = public, teadio, pg_catalog
as $$
declare v_id uuid;
begin
  insert into workers (hostname, machine, owner_id, capabilities, version)
  values (p_hostname, p_machine, p_owner_id, coalesce(p_capabilities, '{}'::jsonb), p_version)
  on conflict (hostname) do update set
      machine      = excluded.machine,
      owner_id     = coalesce(excluded.owner_id, workers.owner_id),
      capabilities = excluded.capabilities,
      version      = excluded.version,
      last_seen    = now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function teadio.worker_heartbeat(
  p_worker uuid, p_capabilities jsonb default null)
returns boolean
language plpgsql security definer set search_path = public, teadio, pg_catalog
as $$
begin
  update workers set
      last_seen    = now(),
      capabilities = coalesce(p_capabilities, capabilities)
   where id = p_worker;
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- Browser RPCs  (public schema → exposed as /rpc/<name> by the Data API)
-- ---------------------------------------------------------------------------

-- Creating a project and becoming its owner is one act, so it is one statement.
-- Doing it as a plain INSERT would deadlock on its own rules: the row is only
-- selectable by members, and the creator is not a member until the row exists,
-- so `insert ... returning id` could not read back the id it just wrote.
create or replace function public.create_project(
  p_slug text, p_name text, p_repo_url text default null)
returns uuid
language plpgsql security definer set search_path = public, teadio, pg_catalog
as $$
declare v_uid text := teadio.uid(); v_id uuid;
begin
  if v_uid is null then
    raise exception 'create_project: not signed in' using errcode = '42501';
  end if;

  insert into projects (slug, name, repo_url) values (p_slug, p_name, p_repo_url)
  returning id into v_id;

  insert into project_members (project_id, user_id, role) values (v_id, v_uid, 'owner');
  return v_id;
end $$;

-- A UI can only mark a row cancelled; it cannot signal a process on someone
-- else's laptop. The worker watches its own row and stops itself.
create or replace function public.cancel_job(p_job uuid) returns boolean
language plpgsql security definer set search_path = public, teadio, pg_catalog
as $$
begin
  update jobs set status = 'cancelled', finished_at = now()
   where id = p_job
     and status in ('pending', 'claimed', 'running')
     and teadio.is_member(project_id);
  return found;
end $$;

-- Called by the console after sign-in. Turns email invitations into real
-- memberships, but only for an address the provider has verified.
create or replace function public.redeem_invites() returns int
language plpgsql security definer set search_path = public, teadio, pg_catalog
as $$
declare v_email text; v_uid text; n int;
begin
  v_email := teadio.verified_email();
  v_uid   := teadio.uid();
  if v_email is null or v_uid is null then return 0; end if;

  with taken as (
    delete from project_invites i where i.email = v_email
    returning i.project_id, i.role
  )
  insert into project_members (project_id, user_id, role)
  select t.project_id, v_uid, t.role from taken t
  on conflict (project_id, user_id) do nothing;

  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from public;
revoke all on all functions in schema public, teadio from public;

-- The console. Column-level INSERT grants are the whole guard on job creation:
-- a member can submit work, but cannot hand-write a status, an artifact_url or
-- a cost, so no UPDATE grant on jobs exists at all.
-- No INSERT on projects: create_project() is the only way in, so a project can
-- never exist without an owner.
grant select                                on projects         to authenticated;
grant update (name, repo_url)               on projects         to authenticated;
grant delete                                on projects         to authenticated;

grant select, insert, delete                on project_members  to authenticated;
grant select, insert, delete                on project_invites  to authenticated;

grant select                                on jobs             to authenticated;
grant insert (project_id, slug, kind, profile, composition_id, commit_sha,
              props, brief, revision_of, feedback)
                                            on jobs             to authenticated;

grant select                                on job_events       to authenticated;
grant select                                on job_files        to authenticated;
grant insert (job_id, filename, content_type, bytes, storage_key)
                                            on job_files        to authenticated;

grant select                                on workers          to authenticated;
grant update (paused)                       on workers          to authenticated;
grant select                                on worker_status    to authenticated;

grant execute on function public.create_project(text, text, text) to authenticated;
grant execute on function public.cancel_job(uuid)                 to authenticated;
grant execute on function public.redeem_invites()                 to authenticated;

-- The policies below call these, and a policy expression is evaluated with the
-- querying role's privileges — without these grants every SELECT fails with
-- "permission denied for function", which reads exactly like a missing policy.
grant execute on function
  teadio.uid(), teadio.is_member(uuid), teadio.is_owner(uuid),
  teadio.can_see_job(uuid), teadio.stale_after()
                                                                  to authenticated;

-- The fleet. Note what is absent: project_members, project_invites, and the
-- `created_by` column of jobs. A worker runs untrusted-ish code on someone's
-- laptop; it has no business knowing who anyone is.
grant select (id, project_id, slug, kind, profile, status, stage, stage_at,
              resume_from_stage, session_id, composition_id, commit_sha, props,
              brief, revision_of, feedback, target_machine, claimed_by, attempts,
              artifact_url, artifact_bytes, render_seconds, frames, cost_usd,
              error, summary, created_at, updated_at, claimed_at, started_at,
              finished_at)
                                            on jobs             to teadio_worker;
grant select (id, slug, name, repo_url)     on projects         to teadio_worker;
grant select                                on job_files        to teadio_worker;
grant select                                on workers          to teadio_worker;

grant execute on function
  teadio.claim_next(uuid, text),
  teadio.job_progress(uuid, uuid, text, text, text),
  teadio.job_finish(uuid, uuid, text, text, bigint, numeric, int, numeric, text, jsonb),
  teadio.release_stale_jobs(int),
  teadio.worker_register(text, text, text, jsonb, text),
  teadio.worker_heartbeat(uuid, jsonb)
                                                                to teadio_worker;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- RLS enabled with no policy means "nobody sees anything", so every table below
-- gets its policies stated explicitly. Absence of a policy is deliberate.

alter table projects        enable row level security;
alter table project_members enable row level security;
alter table project_invites enable row level security;
alter table jobs            enable row level security;
alter table job_files       enable row level security;
alter table job_events      enable row level security;
alter table workers         enable row level security;

create policy projects_read   on projects for select to authenticated
  using (teadio.is_member(id));
create policy projects_update on projects for update to authenticated
  using (teadio.is_owner(id)) with check (teadio.is_owner(id));
create policy projects_delete on projects for delete to authenticated
  using (teadio.is_owner(id));
create policy projects_worker on projects for select to teadio_worker
  using (true);

create policy members_read   on project_members for select to authenticated
  using (teadio.is_member(project_id));
create policy members_add    on project_members for insert to authenticated
  with check (teadio.is_owner(project_id));
create policy members_remove on project_members for delete to authenticated
  using (teadio.is_owner(project_id));

create policy invites_read   on project_invites for select to authenticated
  using (teadio.is_member(project_id));
create policy invites_add    on project_invites for insert to authenticated
  with check (teadio.is_owner(project_id) and invited_by = teadio.uid());
create policy invites_remove on project_invites for delete to authenticated
  using (teadio.is_owner(project_id));

create policy jobs_read   on jobs for select to authenticated
  using (teadio.is_member(project_id));
create policy jobs_create on jobs for insert to authenticated
  with check (teadio.is_member(project_id));
create policy jobs_worker on jobs for select to teadio_worker
  using (true);

create policy files_read   on job_files for select to authenticated
  using (teadio.can_see_job(job_id));
create policy files_add    on job_files for insert to authenticated
  with check (teadio.can_see_job(job_id));
create policy files_worker on job_files for select to teadio_worker
  using (true);

create policy events_read   on job_events for select to authenticated
  using (teadio.can_see_job(job_id));

-- One deployment is one team, so the fleet is visible to everyone signed in —
-- "all workers are offline" is the highest-value thing the console ever says.
create policy workers_read  on workers for select to authenticated
  using (true);
create policy workers_pause on workers for update to authenticated
  using (owner_id = teadio.uid()) with check (owner_id = teadio.uid());
create policy workers_fleet on workers for select to teadio_worker
  using (true);

commit;
