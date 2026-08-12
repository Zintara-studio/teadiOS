// Every database call the worker makes. All of them go through the fenced
// functions in db/schema.sql — this role has no UPDATE grant on any table, so
// there is no way to write to a job you no longer own even by accident.

import pg from 'pg';

export type Job = {
  id: string;
  project_id: string;
  slug: string;
  kind: 'render' | 'generate';
  profile: string | null;
  status: string;
  stage: string | null;
  resume_from_stage: string | null;
  session_id: string | null;
  composition_id: string | null;
  commit_sha: string | null;
  props: Record<string, unknown>;
  brief: string | null;
  attempts: number;
  repo_url: string | null;
};

// Explicit, because `select *` would ask for created_by and be refused. That
// refusal is the point: a worker runs teammate-submitted code on someone's
// laptop and has no business knowing who anyone is.
const JOB_COLUMNS = `
  j.id, j.project_id, j.slug, j.kind, j.profile, j.status, j.stage,
  j.resume_from_stage, j.session_id, j.composition_id, j.commit_sha,
  j.props, j.brief, j.attempts, p.repo_url
`;

export class Db {
  #pool: pg.Pool;

  constructor(connectionString: string) {
    this.#pool = new pg.Pool({
      connectionString,
      max: 2,
      application_name: 'teadios-worker',
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async register(
    hostname: string,
    machine: string,
    ownerId: string | null,
    capabilities: Record<string, unknown>,
    version: string,
  ): Promise<string> {
    const { rows } = await this.#pool.query<{ id: string }>(
      'select teadio.worker_register($1, $2, $3, $4, $5) as id',
      [hostname, machine, ownerId, capabilities, version],
    );
    return rows[0].id;
  }

  async heartbeat(workerId: string, capabilities: Record<string, unknown>): Promise<void> {
    await this.#pool.query('select teadio.worker_heartbeat($1, $2)', [workerId, capabilities]);
  }

  /** The laptop owner's "not right now", set from the console. */
  async isPaused(workerId: string): Promise<boolean> {
    const { rows } = await this.#pool.query<{ paused: boolean }>(
      'select paused from workers where id = $1',
      [workerId],
    );
    return rows[0]?.paused ?? false;
  }

  /** Any worker sweeps on every poll, so there is no cron to forget to run. */
  async releaseStale(): Promise<number> {
    const { rows } = await this.#pool.query<{ n: number }>(
      'select teadio.release_stale_jobs() as n',
    );
    return rows[0].n;
  }

  /** SKIP LOCKED is the load balancer. Returns null when the queue is empty. */
  async claimNext(workerId: string, machine: string): Promise<string | null> {
    const { rows } = await this.#pool.query<{ id: string | null }>(
      'select teadio.claim_next($1, $2) as id',
      [workerId, machine],
    );
    return rows[0].id;
  }

  async getJob(jobId: string): Promise<Job | null> {
    const { rows } = await this.#pool.query<Job>(
      `select ${JOB_COLUMNS} from jobs j join projects p on p.id = j.project_id where j.id = $1`,
      [jobId],
    );
    return rows[0] ?? null;
  }

  /**
   * "Do I still own this, and does anyone still want it?" — polled while a run
   * is in flight. Cheap enough to ask every couple of seconds, and it is how
   * both cancellation and being-reclaimed are noticed. Asking for claimed_by
   * rather than inferring from status matters: a job handed to another laptop
   * stays 'running' the whole time.
   */
  async getOwnership(jobId: string): Promise<{ status: string; claimedBy: string | null } | null> {
    const { rows } = await this.#pool.query<{ status: string; claimed_by: string | null }>(
      'select status, claimed_by from jobs where id = $1',
      [jobId],
    );
    if (!rows[0]) return null;
    return { status: rows[0].status, claimedBy: rows[0].claimed_by };
  }

  /**
   * Returns false when this worker no longer owns the job — which is exactly
   * what a worker finishing late, after its heartbeat lapsed and someone else
   * re-claimed the work, must see. Callers must treat false as "stop now".
   */
  async progress(
    jobId: string,
    workerId: string,
    opts: { stage?: string; level?: 'info' | 'warn' | 'error' | 'stage'; message?: string } = {},
  ): Promise<boolean> {
    const { rows } = await this.#pool.query<{ ok: boolean }>(
      'select teadio.job_progress($1, $2, $3, $4, $5) as ok',
      [jobId, workerId, opts.stage ?? null, opts.level ?? 'info', opts.message ?? null],
    );
    return rows[0].ok;
  }

  async finish(
    jobId: string,
    workerId: string,
    status: 'completed' | 'failed',
    result: {
      artifactUrl?: string;
      artifactBytes?: number;
      renderSeconds?: number;
      frames?: number;
      costUsd?: number;
      error?: string;
      summary?: unknown;
    } = {},
  ): Promise<boolean> {
    const { rows } = await this.#pool.query<{ ok: boolean }>(
      'select teadio.job_finish($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as ok',
      [
        jobId,
        workerId,
        status,
        result.artifactUrl ?? null,
        result.artifactBytes ?? null,
        result.renderSeconds ?? null,
        result.frames ?? null,
        result.costUsd ?? null,
        result.error ?? null,
        result.summary ? JSON.stringify(result.summary) : null,
      ],
    );
    return rows[0].ok;
  }
}
