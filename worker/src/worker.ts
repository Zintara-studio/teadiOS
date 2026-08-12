// One slot. Claims a job, runs it, reports, repeats.
//
// The shape is from system-design.md §4. Everything here that looks paranoid is
// a failure that has actually happened: a laptop that closed its lid halfway
// through, a worker that woke up after its job had been given to someone else,
// a render that finished and then failed to upload.

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { open, mkdir, readdir, readFile, rm, stat, statfs } from 'node:fs/promises';
import { availableParallelism, totalmem } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import type { Config } from './config.ts';
import { Db, type Job } from './db.ts';
import { makeSanitizer } from './sanitize.ts';
import { upload } from './upload.ts';

const execFileAsync = promisify(execFile);

export const VERSION = '0.1.0';

// A cap, stated out loud when it bites. Silently truncating a log reads as
// "that was all the output", which is how you lose an afternoon.
const MAX_LINES = 2_000;

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

// ---------------------------------------------------------------- capabilities

async function freeDiskGb(path: string): Promise<number> {
  try {
    const fs = await statfs(path);
    return (fs.bsize * fs.bavail) / 1e9;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

let acCache: { at: number; on: boolean } | null = null;

/** Undetectable counts as plugged in — never claiming at all is the worse bug. */
async function onMains(): Promise<boolean> {
  if (acCache && Date.now() - acCache.at < 30_000) return acCache.on;
  let on = true;

  try {
    const base = '/sys/class/power_supply';
    for (const entry of await readdir(base)) {
      const type = await readFile(join(base, entry, 'type'), 'utf8').catch(() => '');
      if (type.trim() !== 'Mains') continue;
      const online = await readFile(join(base, entry, 'online'), 'utf8').catch(() => '1');
      on = online.trim() === '1';
      break;
    }
  } catch {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('pmset', ['-g', 'ps'], { timeout: 2_000 })
        .catch(() => ({ stdout: 'AC Power' }));
      on = /AC Power/.test(stdout);
    }
  }

  acCache = { at: Date.now(), on };
  return on;
}

async function capabilities(cfg: Config): Promise<Record<string, unknown>> {
  return {
    cores: availableParallelism(),
    ram_gb: Math.round(totalmem() / 1e9),
    free_disk_gb: Math.round(await freeDiskGb(cfg.runsDir)),
    arch: process.arch,
    platform: process.platform,
    node: process.versions.node,
    kinds: [cfg.renderCmd.length ? 'render' : null, cfg.agentCmd.length ? 'generate' : null].filter(Boolean),
  };
}

/** Returns a reason to sit this round out, or null to go ahead. */
async function preflight(cfg: Config): Promise<string | null> {
  const free = await freeDiskGb(cfg.runsDir);
  // Nothing in a concurrency limiter knows about disk, and running out mid-run
  // costs the whole run — and can corrupt build caches that then need rebuilding.
  if (free < cfg.minFreeDiskGb) {
    return `only ${free.toFixed(1)}GB free, need ${cfg.minFreeDiskGb}GB`;
  }
  if (cfg.requireAc && !(await onMains())) return 'running on battery';
  return null;
}

// ---------------------------------------------------------------- verification

/**
 * Checked from OUTSIDE the process that claims to have done the work. A file
 * can exist and still be empty, truncated, or not a video at all, and a
 * cheerful summary cannot fake an ftyp box.
 */
async function verifyArtifact(path: string): Promise<number> {
  const info = await stat(path).catch(() => null);
  if (!info) throw new Error('reported success but produced no artifact');
  if (info.size < 1024) throw new Error(`artifact is ${info.size} bytes, which is not a video`);

  const fd = await open(path, 'r');
  try {
    const head = Buffer.alloc(12);
    await fd.read(head, 0, 12, 0);
    if (head.subarray(4, 8).toString('latin1') !== 'ftyp') {
      throw new Error('artifact has no ftyp box, so it is not a playable MP4');
    }
  } finally {
    await fd.close();
  }
  return info.size;
}

// ------------------------------------------------------------------- one job

async function runJob(
  db: Db,
  cfg: Config,
  workerId: string,
  job: Job,
  sanitize: (line: string) => string,
  signal: AbortSignal,
): Promise<void> {
  // Anything shared must be per-run. A fixed path is a collision waiting for a
  // second job on the same laptop.
  const runDir = join(cfg.runsDir, job.id);
  const artifact = join(runDir, 'out.mp4');
  await mkdir(runDir, { recursive: true });

  const startedAt = Date.now();
  // Why we are walking away, if we are. Cancelled, reclaimed and shutting down
  // all mean the same thing here — stop, write nothing, bill nothing — so they
  // are one flag rather than three that have to be checked in the same order
  // everywhere.
  let stopped: string | null = null;
  let lines = 0;

  const say = async (
    message: string | null,
    level: 'info' | 'warn' | 'error' | 'stage' = 'info',
    stage?: string,
  ): Promise<void> => {
    if (stopped) return;
    const held = await db.progress(job.id, workerId, { stage, level, message: message ?? undefined });
    if (!held) stopped = 'the database refused the write; this job is not ours';
  };

  try {
    const cmd = job.kind === 'render' ? cfg.renderCmd : cfg.agentCmd;
    if (cmd.length === 0) {
      await db.finish(job.id, workerId, 'failed', {
        error: `this worker has no command configured for kind='${job.kind}'`,
      });
      return;
    }

    // Resume where the last laptop got to, not from zero.
    await say(`claimed by ${cfg.hostname}`, 'stage', job.resume_from_stage ?? 'starting');
    if (stopped) return;

    const child = spawn(cmd[0], [...cmd.slice(1), artifact], {
      cwd: runDir,
      // Its own process group, so cancellation kills this run's tree and only
      // this run's tree. Never kill by process name: `pkill -f chrome` takes
      // out every other run's browser, and sometimes your own shell.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // A curated environment, not process.env. Compositions are teammate-
      // submitted code running on someone's personal laptop; they have no need
      // for the database URL or the R2 keys. TMPDIR lands in the per-run dir.
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        LANG: process.env.LANG,
        TMPDIR: runDir,
        TEADIO_JOB: JSON.stringify(job),
        TEADIO_RUN_DIR: runDir,
        TEADIO_ARTIFACT: artifact,
        ...(job.kind === 'generate' && process.env.ANTHROPIC_API_KEY
          ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
          : {}),
      },
    });

    const kill = (): void => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM');
      } catch { /* already gone */ }
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch { /* already gone */ }
      }, 5_000).unref();
    };

    const stop = (why: string): void => {
      if (stopped) return;
      stopped = why;
      process.stdout.write(`${cfg.hostname} dropping ${job.slug}: ${why}\n`);
      kill();
    };

    // Shutting down must not mean waiting out an hour-long render. The job goes
    // back to the queue on its own once the heartbeat lapses.
    const onAbort = (): void => stop('the worker is shutting down');
    signal.addEventListener('abort', onAbort, { once: true });

    // A console can only mark the row; it cannot signal a process on someone
    // else's laptop. So the worker watches its own row. The same poll notices
    // the job being handed to another machine while we were still holding it —
    // that stays 'running' throughout, so only claimed_by reveals it.
    const watch = setInterval(() => {
      void db.getOwnership(job.id).then((state) => {
        if (!state) stop('the job row is gone');
        else if (state.status === 'cancelled') stop('cancelled from the console');
        else if (state.claimedBy !== workerId) stop('reclaimed by another worker');
        else if (!['claimed', 'running'].includes(state.status)) stop(`status became ${state.status}`);
      }).catch(() => { /* a blip is not a reason to kill an hour of rendering */ });
    }, cfg.pollMs);

    const exited = new Promise<number>((resolve) => {
      child.on('close', (code, signal) => resolve(code ?? (signal ? 143 : 1)));
      child.on('error', () => resolve(127));
    });

    const pump = async (stream: NodeJS.ReadableStream, level: 'info' | 'warn'): Promise<void> => {
      for await (const raw of createInterface({ input: stream, crlfDelay: Infinity })) {
        if (lines === MAX_LINES) await say(`output capped at ${MAX_LINES} lines`, 'warn');
        if (lines++ >= MAX_LINES) continue;
        const clean = sanitize(raw);
        if (clean) await say(clean, level);
      }
    };

    try {
      await Promise.all([pump(child.stdout!, 'info'), pump(child.stderr!, 'warn')]);
      var code = await exited;
    } finally {
      clearInterval(watch);
      signal.removeEventListener('abort', onAbort);
    }

    // Cancelled, reclaimed, or shutting down. Say nothing, write nothing, bill
    // nothing — two workers would otherwise charge for the same job.
    if (stopped) return;

    if (code !== 0) {
      await db.finish(job.id, workerId, 'failed', { error: `exited with code ${code}` });
      return;
    }

    await say(null, 'stage', 'uploading');
    if (stopped) return;

    const bytes = await verifyArtifact(artifact);
    const key = `${job.project_id}/${job.slug}-${job.id}.mp4`;
    const stored = await upload(artifact, key, cfg);

    const held = await db.finish(job.id, workerId, 'completed', {
      artifactUrl: stored.url,
      artifactBytes: bytes,
      renderSeconds: (Date.now() - startedAt) / 1000,
    });
    if (!held) stopped = 'the database refused the final write';
  } catch (err) {
    if (stopped) return;
    // Verification and upload failures land here, and they must fail the job.
    // A run that rendered and could not upload is not a success.
    await db.finish(job.id, workerId, 'failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ the loop

export async function runSlot(cfg: Config, signal: AbortSignal): Promise<void> {
  const db = new Db(cfg.databaseUrl);
  // Told what its secrets are, rather than left to infer them from variable
  // names. Everything a child prints is about to be readable in a browser.
  const sanitize = makeSanitizer(
    [
      cfg.databaseUrl,
      cfg.r2?.accessKeyId,
      cfg.r2?.secretAccessKey,
      process.env.ANTHROPIC_API_KEY,
    ].filter((v): v is string => Boolean(v)),
  );
  await mkdir(cfg.runsDir, { recursive: true });

  const workerId = await db.register(
    cfg.hostname, cfg.machine, cfg.ownerId, await capabilities(cfg), VERSION,
  );
  process.stdout.write(`${cfg.hostname} registered as ${workerId}\n`);

  const beat = setInterval(() => {
    void capabilities(cfg).then((caps) => db.heartbeat(workerId, caps)).catch(() => {});
  }, cfg.heartbeatMs);

  let quiet: string | null = null;   // last reason we sat a round out, to log it once

  try {
    while (!signal.aborted) {
      try {
        // Any worker sweeps. There is no separate cron to forget to run, and no
        // single machine whose absence stops jobs being reclaimed.
        await db.releaseStale();

        const reason = (await db.isPaused(workerId)) ? 'paused by its owner' : await preflight(cfg);
        if (reason) {
          if (reason !== quiet) {
            process.stdout.write(`${cfg.hostname} sitting out: ${reason}\n`);
            quiet = reason;
          }
          await sleep(cfg.pollMs, signal);
          continue;
        }
        quiet = null;

        const jobId = await db.claimNext(workerId, cfg.machine);
        if (!jobId) {
          await sleep(cfg.pollMs, signal);
          continue;
        }

        const job = await db.getJob(jobId);
        if (job) await runJob(db, cfg, workerId, job, sanitize, signal);
      } catch (err) {
        // A database blip must not kill the worker; the next poll retries.
        process.stderr.write(`${cfg.hostname} loop error: ${sanitize(String(err))}\n`);
        await sleep(cfg.pollMs, signal);
      }
    }
  } finally {
    clearInterval(beat);
    // A job still held here goes back to the queue on its own after
    // teadio.stale_after(). ponytail: 45s of dead air on a clean shutdown; add
    // an explicit release function if that ever feels slow.
    await db.close();
  }
}
