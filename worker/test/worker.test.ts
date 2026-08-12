// Build order step 2: prove claim, heartbeat, stale reclaim, fenced writes and
// cancellation with a fake agent, before real rendering is anywhere near it.
//
//   docker run -d --name teadio-pg -e POSTGRES_PASSWORD=x -p 55432:5432 postgres:18
//   npm test
//
// Each test gets a fresh database, and the worker connects as teadio_w1 — the
// same narrow role it uses in production — so the column grants and policies are
// exercised here rather than discovered later.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { load, type Config } from '../src/config.ts';
import { runSlot } from '../src/worker.ts';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const SCHEMA = resolve(HERE, '../../db/schema.sql');
const FAKE_AGENT = join(HERE, 'fake-agent.mjs');

const ADMIN =
  process.env.TEADIO_TEST_ADMIN_URL ?? 'postgresql://postgres:x@localhost:55432/postgres';
const WORKER_PASSWORD = 'a-long-and-boring-password';

let dbName: string;
let admin: pg.Client;
let workerUrl: string;
let runsDir: string;
let artifactDir: string;

// --------------------------------------------------------------------- setup

before(async () => {
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  dbName = `teadio_test_${Date.now().toString(36)}`;
  await root.query(`create database ${dbName}`);
  await root.end();

  const url = new URL(ADMIN);
  url.pathname = `/${dbName}`;
  admin = new pg.Client({ connectionString: url.toString() });
  await admin.connect();
  await admin.query(await readFile(SCHEMA, 'utf8'));

  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'teadio_w1') then
        create role teadio_w1 login password '${WORKER_PASSWORD}';
      end if;
    end $$;
    grant teadio_worker to teadio_w1;
  `);

  const w = new URL(url.toString());
  w.username = 'teadio_w1';
  w.password = WORKER_PASSWORD;
  workerUrl = w.toString();

  runsDir = await mkdtemp(join(tmpdir(), 'teadio-runs-'));
  artifactDir = await mkdtemp(join(tmpdir(), 'teadio-cdn-'));
});

after(async () => {
  await admin?.end();
  const root = new pg.Client({ connectionString: ADMIN });
  await root.connect();
  await root.query(`drop database if exists ${dbName} with (force)`);
  await root.end();
});

// ------------------------------------------------------------------- helpers

function config(over: Record<string, string> = {}, slot = 0): Config {
  return load(
    {
      TEADIO_DATABASE_URL: workerUrl,
      TEADIO_MACHINE: 'test-box',
      TEADIO_POLL_MS: '150',
      TEADIO_HEARTBEAT_MS: '500',
      TEADIO_REQUIRE_AC: 'false',
      TEADIO_MIN_FREE_DISK_GB: '0',
      TEADIO_RUNS_DIR: runsDir,
      TEADIO_ARTIFACT_DIR: artifactDir,
      TEADIO_CDN_BASE: 'https://cdn.test',
      TEADIO_RENDER_CMD: `${process.execPath} ${FAKE_AGENT}`,
      TEADIO_AGENT_CMD: `${process.execPath} ${FAKE_AGENT}`,
      ...over,
    } as NodeJS.ProcessEnv,
    slot,
  );
}

let projectId: string;

async function project(): Promise<string> {
  if (projectId) return projectId;
  const { rows } = await admin.query<{ id: string }>(
    `insert into projects (slug, name) values ('alpha', 'Alpha') returning id`,
  );
  projectId = rows[0].id;
  return projectId;
}

async function queue(slug: string, props: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into jobs (project_id, slug, kind, props, created_by)
     values ($1, $2, 'render', $3, 'user_test') returning id`,
    [await project(), slug, JSON.stringify(props)],
  );
  return rows[0].id;
}

async function job(id: string): Promise<Record<string, any>> {
  const { rows } = await admin.query(`select * from jobs where id = $1`, [id]);
  return rows[0];
}

async function feed(id: string): Promise<string> {
  const { rows } = await admin.query<{ message: string }>(
    `select message from job_events where job_id = $1 order by id`,
    [id],
  );
  return rows.map((r) => r.message).join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until the predicate holds, or fail loudly with what we last saw. */
async function until<T>(what: string, fn: () => Promise<T | null>, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last as T;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
}

/** Run one or more slots for the duration of `fn`, then shut them down. */
async function withWorkers<T>(cfgs: Config[], fn: () => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const running = cfgs.map((c) => runSlot(c, ac.signal));
  try {
    return await fn();
  } finally {
    ac.abort();
    await Promise.allSettled(running);
  }
}

const statusOf = (id: string) => async () => {
  const j = await job(id);
  return ['completed', 'failed', 'cancelled'].includes(j.status) ? j : null;
};

// --------------------------------------------------------------------- tests

describe('the loop', () => {
  it('claims a job, runs it, uploads, and only then calls it done', async () => {
    const id = await queue('happy-path');
    const done = await withWorkers([config()], () => until('the job to finish', statusOf(id)));

    assert.equal(done.status, 'completed');
    assert.equal(done.artifact_url, `https://cdn.test/${done.project_id}/happy-path-${id}.mp4`);
    assert.ok(done.artifact_bytes > 1024, 'artifact_bytes should be recorded');
    assert.ok(Number(done.render_seconds) >= 0, 'render_seconds should be recorded');
    assert.ok(done.claimed_at && done.started_at && done.finished_at);

    const log = await feed(id);
    assert.match(log, /bundling composition/);
    assert.match(log, /render complete/);
  });

  it('registers one row per process and pins jobs to the machine, not the slot', async () => {
    await withWorkers([config({}, 0), config({}, 1)], async () => {
      await until('both slots to register', async () => {
        const { rows } = await admin.query(`select hostname, machine from workers order by hostname`);
        return rows.length === 2 ? rows : null;
      });
    });

    const { rows } = await admin.query<{ hostname: string; machine: string }>(
      `select hostname, machine from workers order by hostname`,
    );
    assert.deepEqual(rows.map((r) => r.hostname), ['test-box.slot0', 'test-box.slot1']);
    assert.deepEqual([...new Set(rows.map((r) => r.machine))], ['test-box'],
      'both slots must share one machine — a job pins to the disk, not the process');
  });

  it('heartbeats, so the fleet reads as online from the database clock', async () => {
    await withWorkers([config()], async () => {
      await until('a heartbeat', async () => {
        const { rows } = await admin.query(`select count(*)::int as n from worker_status where online`);
        return rows[0].n > 0 ? rows[0] : null;
      });
      // And it keeps beating rather than going stale mid-run.
      await sleep(1_200);
      const { rows } = await admin.query(`select count(*)::int as n from worker_status where online`);
      assert.ok(rows[0].n > 0, 'worker went stale while it was still running');
    });
  });
});

describe('not trusting the agent', () => {
  it('fails a job whose agent claimed success but produced nothing', async () => {
    const id = await queue('cheerful-liar', { mode: 'no-artifact' });
    const done = await withWorkers([config()], () => until('a verdict', statusOf(id)));

    assert.equal(done.status, 'failed');
    assert.match(done.error, /produced no artifact/);
    assert.match(await feed(id), /render complete! the video is ready/,
      'the lie should still be in the feed — that is the evidence');
  });

  it('rejects an artifact that exists but is empty', async () => {
    const id = await queue('empty-file', { mode: 'empty' });
    const done = await withWorkers([config()], () => until('a verdict', statusOf(id)));
    assert.equal(done.status, 'failed');
    assert.match(done.error, /not a video|0 bytes/);
  });

  it('rejects a large file that is not actually a video', async () => {
    const id = await queue('not-a-video', { mode: 'not-video' });
    const done = await withWorkers([config()], () => until('a verdict', statusOf(id)));
    assert.equal(done.status, 'failed');
    assert.match(done.error, /ftyp/);
  });

  it('fails a job whose agent exits non-zero', async () => {
    const id = await queue('exit-three', { mode: 'fail' });
    const done = await withWorkers([config()], () => until('a verdict', statusOf(id)));
    assert.equal(done.status, 'failed');
    assert.match(done.error, /code 3/);
    assert.match(await feed(id), /composition "missing" not found/);
  });

  it('fails a job that rendered but could not be uploaded', async () => {
    // A file where a directory should be, so the copy cannot land.
    const blocker = join(runsDir, 'blocker');
    await writeFile(blocker, 'not a directory');

    const id = await queue('upload-fails');
    const done = await withWorkers(
      [config({ TEADIO_ARTIFACT_DIR: join(blocker, 'nope') })],
      () => until('a verdict', statusOf(id)),
    );

    assert.equal(done.status, 'failed', 'a run that could not upload is not a success');
    assert.equal(done.artifact_url, null);
  });
});

describe('when a laptop misbehaves', () => {
  it('stops when someone cancels, without overwriting the row', async () => {
    const id = await queue('cancel-me', { mode: 'hang' });
    let stoppedItself = false;

    await withWorkers([config()], async () => {
      await until('the run to start', async () => {
        const j = await job(id);
        return j.status === 'running' ? j : null;
      });
      await admin.query(`update jobs set status = 'cancelled' where id = $1`, [id]);
      await sleep(1_500);
      // Checked while the worker is still alive. Asserting after shutdown would
      // pass even if the worker had ignored the cancellation entirely, because
      // shutting down kills the child too.
      stoppedItself = !existsSync(join(runsDir, id));
    });

    assert.ok(stoppedItself,
      'the worker kept rendering a cancelled job — a UI can only mark the row');

    const done = await job(id);
    assert.equal(done.status, 'cancelled', 'the worker must not rewrite a cancelled row');
    assert.equal(done.artifact_url, null);
  });

  it('walks away from a job handed to another laptop while it was still working', async () => {
    const id = await queue('reclaimed', { mode: 'hang' });
    let eventsAtHandover = 0;
    let stoppedItself = false;

    await withWorkers([config()], async () => {
      await until('the run to start', async () => {
        const j = await job(id);
        return j.status === 'running' ? j : null;
      });

      // Reclaimed and given to another machine. The row stays 'running' the
      // whole time, so nothing but claimed_by reveals the handover.
      const { rows } = await admin.query<{ id: string }>(
        `select teadio.worker_register('other-box.slot0', 'other-box', null, '{}'::jsonb, '0.1.0') as id`,
      );
      await admin.query(`update jobs set claimed_by = $2 where id = $1`, [id, rows[0].id]);

      const counted = await admin.query<{ n: number }>(
        `select count(*)::int as n from job_events where job_id = $1`, [id],
      );
      eventsAtHandover = counted.rows[0].n;
      await sleep(2_000);
      stoppedItself = !existsSync(join(runsDir, id));
    });

    assert.ok(stoppedItself,
      'it kept rendering after losing the claim — the run directory is still there');

    const done = await job(id);
    assert.equal(done.status, 'running',
      'the original worker must not finish, fail or cancel a job it no longer owns');
    assert.equal(done.error, null);
    assert.equal(done.artifact_url, null);

    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from job_events where job_id = $1`, [id],
    );
    assert.ok(rows[0].n - eventsAtHandover <= 1,
      `it kept writing to the feed after losing the claim (+${rows[0].n - eventsAtHandover} lines)`);
  });

  it('stops a running job when the worker is told to shut down', async () => {
    const id = await queue('shutdown-mid-render', { mode: 'hang' });
    const ac = new AbortController();
    const running = runSlot(config(), ac.signal);

    await until('the run to start', async () => {
      const j = await job(id);
      return j.status === 'running' ? j : null;
    });

    ac.abort();
    // Must not wait for an hour-long render to finish on its own.
    await Promise.race([
      running,
      sleep(8_000).then(() => { throw new Error('shutdown did not interrupt the running job'); }),
    ]);

    const done = await job(id);
    assert.equal(done.status, 'running',
      'a job dropped by shutdown stays claimed until the stale sweep requeues it');
    assert.equal(done.error, null, 'shutting down is not the job failing');
  });

  it('reclaims a job whose worker went away, and another slot resumes it', async () => {
    const id = await queue('abandoned');

    // A worker that claimed the job and then vanished without a trace.
    const { rows } = await admin.query<{ id: string }>(
      `select teadio.worker_register('ghost-box.slot0', 'ghost-box', null, '{}'::jsonb, '0.1.0') as id`,
    );
    await admin.query(`select teadio.claim_next($1, 'ghost-box')`, [rows[0].id]);
    await admin.query(`select teadio.job_progress($1, $2, 'rendering', 'stage', 'frame 10/900')`,
      [id, rows[0].id]);
    await admin.query(`update workers set last_seen = now() - interval '10 minutes' where id = $1`,
      [rows[0].id]);

    const done = await withWorkers([config()], () => until('the rescue', statusOf(id)));

    assert.equal(done.status, 'completed', 'another laptop should have picked it up');
    assert.equal(done.resume_from_stage, 'rendering',
      'and it should have been told where the last one got to');
    assert.ok(done.attempts >= 2, 'the abandoned attempt should be counted');
  });

  it('never hands the same job to two workers', async () => {
    const id = await queue('only-once');
    const done = await withWorkers(
      [config({}, 0), config({}, 1), config({}, 2)],
      () => until('the job to finish', statusOf(id)),
    );

    assert.equal(done.status, 'completed');
    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from job_events
        where job_id = $1 and message like 'fake-agent starting%'`,
      [id],
    );
    assert.equal(rows[0].n, 1, 'the agent should have started exactly once');
  });
});

describe('the event feed is an egress path', () => {
  it("redacts credentials, including this worker's own database password", async () => {
    const id = await queue('leaky', { mode: 'leak', leak: WORKER_PASSWORD });
    await withWorkers([config()], () => until('the job to finish', statusOf(id)));

    const log = await feed(id);
    assert.doesNotMatch(log, new RegExp(WORKER_PASSWORD),
      'the worker leaked its own database password into a browser-readable feed');
    assert.doesNotMatch(log, /hunter2/, 'a password inside a connection string survived');
    assert.doesNotMatch(log, /sk-ant-api03-AAAA/, 'an API key survived');
    assert.doesNotMatch(log, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./, 'a JWT survived');
    assert.match(log, /redacted|\*\*\*/, 'something should show it was redacted, not dropped');
  });

  it('caps a runaway log and says that it did', async () => {
    const id = await queue('very-noisy', { mode: 'noisy' });
    await withWorkers([config()], () => until('the job to finish', statusOf(id)));

    const { rows } = await admin.query<{ n: number }>(
      `select count(*)::int as n from job_events where job_id = $1`,
      [id],
    );
    assert.ok(rows[0].n < 2_100, `feed should be capped, got ${rows[0].n} rows`);
    assert.match(await feed(id), /output capped at 2000 lines/,
      'a silent cap reads as "that was all the output"');
  });
});
