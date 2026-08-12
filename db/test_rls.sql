-- teadio — adversarial policy and queue suite.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/test_rls.sql
--
-- Everything runs inside one transaction and is ROLLED BACK, including the test
-- roles, so it is safe to point at a real database. It proves the things that
-- are expensive to discover later: an outsider sees nothing, a member cannot
-- escalate, a worker cannot read identities, two workers cannot take the same
-- job, and a worker that lost its claim cannot overwrite the one that has it.
--
-- Against a throwaway Postgres, no Neon account needed:
--   docker run -d --name teadio-pg -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:18

\set ON_ERROR_STOP on
set client_min_messages = notice;

begin;

-- ---------------------------------------------------------------------------
-- Harness
-- ---------------------------------------------------------------------------

create function pg_temp.ok(cond boolean, msg text) returns void
language plpgsql as $$
begin
  if cond then
    raise notice '  ok      %', msg;
  else
    raise exception using errcode = 'TE001', message = 'FAIL    ' || msg;
  end if;
end $$;

-- Asserts a statement is REFUSED. Row-level security filtering a SELECT down to
-- zero rows is not a refusal — use ok(count = 0) for that.
create function pg_temp.denied(stmt text, msg text) returns void
language plpgsql as $$
begin
  execute stmt;
  raise exception using errcode = 'TE001', message = 'FAIL    not denied: ' || msg;
exception when others then
  if sqlstate = 'TE001' then raise; end if;
  raise notice '  ok      denied: % [%]', msg, sqlstate;
end $$;

-- Test roles. Membership in `authenticated` gives them its grants and policies
-- while keeping them out from under the table owner, who bypasses RLS entirely.
create role teadio_tester nologin;
create role teadio_wtest  nologin;
grant authenticated to teadio_tester;
grant teadio_worker to teadio_wtest;
do $$ begin
  execute format('grant teadio_tester, teadio_wtest to %I', current_user);
end $$;

-- ---------------------------------------------------------------------------
\echo ''
\echo '== identity and project creation'
-- ---------------------------------------------------------------------------

set role teadio_tester;
set teadio.test_uid = 'user_alice';

select pg_temp.ok(teadio.uid() = 'user_alice', 'uid() resolves the impersonated user');

select create_project('alpha', 'Alpha Videos', 'https://github.com/team/alpha') as newproj \gset
select pg_temp.ok(
  (select count(*) from projects where slug = 'alpha') = 1,
  'the creator can read back the project she just created');
select pg_temp.ok(
  (select m.role from project_members m where m.user_id = 'user_alice') = 'owner',
  'the creator is its owner');

select id from projects where slug = 'alpha' \gset alpha_

insert into jobs (project_id, slug, kind, props)
values (:'alpha_id', 'launch-teaser', 'render', '{"title":"hello"}');
insert into jobs (project_id, slug, kind, brief)
values (:'alpha_id', 'q3-recap', 'generate', 'a 30 second recap of Q3');

select pg_temp.ok((select count(*) from jobs) = 2, 'she sees her own jobs');
select pg_temp.ok(
  (select created_by from jobs where slug = 'launch-teaser') = 'user_alice',
  'created_by defaults to the signed-in user');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== an outsider sees nothing'
-- ---------------------------------------------------------------------------

set teadio.test_uid = 'user_mallory';

select pg_temp.ok((select count(*) from projects)        = 0, 'no projects');
select pg_temp.ok((select count(*) from jobs)            = 0, 'no jobs');
select pg_temp.ok((select count(*) from project_members) = 0, 'no members');
select pg_temp.ok((select count(*) from job_events)      = 0, 'no events');

select pg_temp.denied(
  format('insert into jobs (project_id, slug, kind) values (%L, %L, %L)',
         :'alpha_id', 'not-mine', 'render'),
  'cannot queue a job into a project he cannot see');

select pg_temp.denied(
  format('insert into project_members (project_id, user_id, role) values (%L, %L, %L)',
         :'alpha_id', 'user_mallory', 'owner'),
  'cannot add himself to a project');

-- An unsigned-in session is an outsider with no id at all.
reset teadio.test_uid;
select pg_temp.ok(teadio.uid() is null, 'no identity resolves to NULL, not to a wildcard');
select pg_temp.ok((select count(*) from projects) = 0, 'and sees no projects');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== invitations require a verified address'
-- ---------------------------------------------------------------------------

set teadio.test_uid = 'user_alice';
insert into project_invites (project_id, email, invited_by)
values (:'alpha_id', 'bob@example.com', 'user_alice');

set teadio.test_uid = 'user_bob';
set teadio.test_email = 'bob@example.com';
select pg_temp.ok(redeem_invites() = 1, 'the invited address redeems its invitation');
select pg_temp.ok((select count(*) from projects) = 1, 'the new member sees the project');
select pg_temp.ok((select count(*) from jobs) = 2, 'and the jobs');

set teadio.test_uid = 'user_mallory';
set teadio.test_email = 'mallory@example.com';
select pg_temp.ok(redeem_invites() = 0, 'an uninvited address redeems nothing');
select pg_temp.ok((select count(*) from projects) = 0, 'and still sees nothing');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== a member cannot escalate'
-- ---------------------------------------------------------------------------

set teadio.test_uid = 'user_bob';

select pg_temp.denied(
  format('update project_members set role = %L where user_id = %L', 'owner', 'user_bob'),
  'cannot promote himself to owner');

select pg_temp.denied(
  format('insert into project_members (project_id, user_id, role) values (%L, %L, %L)',
         :'alpha_id', 'user_bob2', 'owner'),
  'cannot invent a new owner');

with d as (delete from project_members where user_id = 'user_alice' returning 1)
select pg_temp.ok((select count(*) from d) = 0, 'cannot remove the owner');

with d as (delete from projects where id = :'alpha_id' returning 1)
select pg_temp.ok((select count(*) from d) = 0, 'cannot delete the project');

select pg_temp.denied(
  'update jobs set status = ''completed'', artifact_url = ''https://evil/x.mp4''',
  'cannot hand-write a job result');

select pg_temp.denied(
  format('insert into jobs (project_id, slug, kind, status, cost_usd) values (%L, %L, %L, %L, %L)',
         :'alpha_id', 'forged', 'render', 'completed', 0),
  'cannot set status or cost at insert time');

select pg_temp.denied(
  'insert into job_events (job_id, message)
   values ((select id from jobs limit 1), ''forged log line'')',
  'cannot write to the append-only event feed');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== one live job per (project, kind, slug)'
-- ---------------------------------------------------------------------------

set teadio.test_uid = 'user_alice';
select pg_temp.denied(
  format('insert into jobs (project_id, slug, kind) values (%L, %L, %L)',
         :'alpha_id', 'launch-teaser', 'render'),
  'a second live run cannot fight over the same working directory');

insert into jobs (project_id, slug, kind) values (:'alpha_id', 'launch-teaser', 'generate');
select pg_temp.ok(true, 'the same slug is fine for a different kind');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== the worker role cannot read identities'
-- ---------------------------------------------------------------------------

reset role;
set role teadio_wtest;

select pg_temp.denied('select * from project_members', 'cannot read project_members');
select pg_temp.denied('select * from project_invites', 'cannot read project_invites');
select pg_temp.denied('select created_by from jobs',   'cannot read jobs.created_by');
select pg_temp.denied('update jobs set stage = ''x''', 'has no unfenced write path');
select pg_temp.denied(
  'insert into job_events (job_id, message) values ((select id from jobs limit 1), ''direct'')',
  'cannot write the feed except through job_progress');

select pg_temp.ok((select count(*) from jobs) = 3,     'can see the queue itself');
select pg_temp.ok((select count(*) from projects) = 1, 'can see the project to clone');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== claiming'
-- ---------------------------------------------------------------------------

select teadio.worker_register('laptop-a.slot0', 'laptop-a', 'user_alice',
                              '{"cores":10,"free_disk_gb":80}'::jsonb, '0.1.0') as reg \gset
select id from workers where hostname = 'laptop-a.slot0' \gset w1_
select teadio.worker_register('laptop-a.slot1', 'laptop-a', 'user_alice',
                              '{"cores":10,"free_disk_gb":80}'::jsonb, '0.1.0') as reg \gset
select id from workers where hostname = 'laptop-a.slot1' \gset w2_

select pg_temp.ok(:'w1_id' <> :'w2_id',
  'two slots on one box are two rows, not one fighting over a heartbeat');
select pg_temp.ok((select count(distinct machine) from workers) = 1,
  'and they share one machine');

select teadio.claim_next(:'w1_id', 'laptop-a') as claim1 \gset
select teadio.claim_next(:'w2_id', 'laptop-a') as claim2 \gset
select pg_temp.ok(:'claim1' <> '' and :'claim2' <> '' and :'claim1' <> :'claim2',
  'SKIP LOCKED: two workers never take the same job');
select pg_temp.ok((select count(*) from jobs where status = 'claimed') = 2,
  'both claims landed');

select pg_temp.ok(teadio.claim_next(:'w1_id', 'laptop-a') is not null,
  'the third queued job is claimable');
select pg_temp.ok(teadio.claim_next(:'w1_id', 'laptop-a') is null,
  'an empty queue returns nothing rather than blocking');

reset role;
insert into jobs (project_id, slug, kind, target_machine)
values (:'alpha_id', 'pinned-run', 'render', 'laptop-b');
set role teadio_wtest;

select pg_temp.ok(teadio.claim_next(:'w1_id', 'laptop-a') is null,
  'a job pinned to another machine is not claimable here');
select pg_temp.ok(teadio.claim_next(:'w1_id', 'laptop-b') is not null,
  'and is claimable on the machine it names');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== fenced writes'
-- ---------------------------------------------------------------------------

select pg_temp.ok(
  teadio.job_progress(:'claim1', :'w1_id', 'bundling', 'stage', 'bundling composition'),
  'the owning worker can report progress');

-- `is false`, not `= false`, so a regression cannot pass by returning NULL.
select pg_temp.ok(
  teadio.job_progress(:'claim1', :'w2_id', 'sabotage', 'info', 'not mine') is false,
  'a worker that does not own the job is refused');
select pg_temp.ok(
  (select stage from jobs where id = :'claim1') = 'bundling',
  'and the stage it tried to overwrite is unchanged');
select pg_temp.ok(
  (select stage_at is not null from jobs where id = :'claim1'),
  'entering a stage stamps stage_at, so the console can show time-in-stage');

reset role;
select pg_temp.ok(
  (select count(*) from job_events where job_id = :'claim1') = 1,
  'the refused write left nothing in the feed');
set role teadio_wtest;

-- ---------------------------------------------------------------------------
\echo ''
\echo '== a run that could not upload is not a success'
-- ---------------------------------------------------------------------------

select pg_temp.denied(
  format('select teadio.job_finish(%L, %L, %L)', :'claim1', :'w1_id', 'completed'),
  'completed without an artifact_url is rejected by the database itself');

select pg_temp.ok(
  teadio.job_finish(:'claim1', :'w1_id', 'completed',
                    'https://cdn.example/teaser.mp4', 8340221, 412.5, 900, 0.0),
  'completed with an artifact is accepted');
select pg_temp.ok(
  (select status from jobs where id = :'claim1') = 'completed', 'and the row is terminal');

select pg_temp.ok(
  teadio.job_finish(:'claim1', :'w1_id', 'completed', 'https://evil/replaced.mp4') is false,
  'a terminal job cannot be finished twice');

select pg_temp.denied(
  format('select teadio.job_finish(%L, %L, %L)', :'claim2', :'w2_id', 'cancelled'),
  'job_finish refuses a non-terminal status');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== a laptop that closed its lid'
-- ---------------------------------------------------------------------------

reset role;
update workers set last_seen = now() - interval '10 minutes' where id = :'w2_id';
set role teadio_wtest;

select pg_temp.ok(teadio.release_stale_jobs() >= 1, 'the sweep reclaims the abandoned job');
select pg_temp.ok(
  (select status from jobs where id = :'claim2') = 'pending', 'the job is queued again');
select pg_temp.ok(
  (select claimed_by from jobs where id = :'claim2') is null, 'and is no longer owned');
select pg_temp.ok(
  (select attempts from jobs where id = :'claim2') = 1, 'its attempt is remembered');
select pg_temp.ok(
  (select resume_from_stage from jobs where id = :'claim2') is not distinct from
  (select stage from jobs where id = :'claim2'),
  'and it carries the stage it reached, so the next worker resumes');

select pg_temp.ok(teadio.claim_next(:'w1_id', 'laptop-a') = :'claim2',
  'another laptop picks it up');
select pg_temp.ok(
  teadio.job_progress(:'claim2', :'w1_id', 'rendering', 'stage', 'frame 0/900'),
  'the new owner may write');
select pg_temp.ok(
  teadio.job_progress(:'claim2', :'w2_id', 'rendering') is false,
  'the original worker, finishing late, is fenced out');

-- Repeated abandonment must eventually fail loudly rather than loop forever.
reset role;
update workers set last_seen = now() - interval '10 minutes';
update jobs set attempts = 3 where id = :'claim2';
set role teadio_wtest;

select pg_temp.ok(teadio.release_stale_jobs(3) >= 1, 'the sweep runs again');
select pg_temp.ok(
  (select status from jobs where id = :'claim2') = 'failed',
  'a job whose laptop keeps vanishing fails instead of retrying forever');
select pg_temp.ok(
  (select error from jobs where id = :'claim2') like 'abandoned:%', 'and says why');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== liveness comes from the database clock'
-- ---------------------------------------------------------------------------

reset role;
set role teadio_tester;
set teadio.test_uid = 'user_alice';

select pg_temp.ok((select count(*) from worker_status where online) = 0,
  'workers last heard from ten minutes ago are offline');
select pg_temp.ok((select count(*) from jobs where status = 'pending') > 0,
  'and there is queued work — this pair is what the console must shout about');

reset role;
select teadio.worker_heartbeat(:'w1_id') as beat \gset
set role teadio_tester;
set teadio.test_uid = 'user_alice';
select pg_temp.ok((select online from worker_status where id = :'w1_id'),
  'a heartbeat brings it back online');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== cancellation'
-- ---------------------------------------------------------------------------

select id from jobs where status = 'pending' order by created_at limit 1 \gset c_
select pg_temp.ok(cancel_job(:'c_id'), 'a member can cancel a queued run');
select pg_temp.ok((select status from jobs where id = :'c_id') = 'cancelled',
  'the row is marked, and the worker is the one that acts on it');
select pg_temp.ok(cancel_job(:'c_id') is false, 'cancelling a terminal job does nothing');

-- Captured while still signed in as a member: Mallory cannot even see an id.
select id from jobs where status in ('pending', 'claimed', 'running') limit 1 \gset m_
set teadio.test_uid = 'user_mallory';
select pg_temp.ok(cancel_job(:'m_id') is false, 'an outsider cannot cancel other people''s work');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== the laptop owner keeps control of the laptop'
-- ---------------------------------------------------------------------------

set teadio.test_uid = 'user_alice';
update workers set paused = true where id = :'w1_id';
select pg_temp.ok((select paused from workers where id = :'w1_id'),
  'the owner can pause her own machine');

set teadio.test_uid = 'user_bob';
with u as (update workers set paused = false where id = :'w1_id' returning 1)
select pg_temp.ok((select count(*) from u) = 0, 'and nobody else can unpause it');
select pg_temp.denied('update workers set machine = ''stolen''',
  'nor change anything but the pause switch');

-- ---------------------------------------------------------------------------
\echo ''
\echo '== anonymous'
-- ---------------------------------------------------------------------------

reset role;
select pg_temp.ok(not has_table_privilege('anonymous', 'jobs', 'select'),
  'the anonymous role reaches no table');
select pg_temp.ok(not has_table_privilege('anonymous', 'projects', 'select'),
  'not even the project list');

rollback;

\echo ''
\echo 'ALL PASSED — schema, policies and queue. Nothing was committed.'
\echo ''
