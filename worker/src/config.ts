// Every environment variable is read and validated here, once, at startup.
// A worker that is going to be wrong about its configuration should be wrong
// immediately and loudly, not four hours into someone's render.

import { hostname as osHostname } from 'node:os';
import { resolve } from 'node:path';

export type R2 = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export type Config = {
  databaseUrl: string;
  machine: string;
  hostname: string;
  slot: number;
  slots: number;
  ownerId: string | null;
  pollMs: number;
  heartbeatMs: number;
  requireAc: boolean;
  minFreeDiskGb: number;
  runsDir: string;
  renderCmd: string[];
  agentCmd: string[];
  cdnBase: string | null;
  artifactDir: string | null;
  r2: R2 | null;
};

const num = (v: string | undefined, fallback: number, name: string): number => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(v)}`);
  return n;
};

const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v === '' ? fallback : /^(1|true|yes|on)$/i.test(v);

// Naive whitespace split. Enough for `node test/fake-agent.mjs` or a path to a
// binary; anything needing real quoting belongs in a wrapper script.
const argv = (v: string | undefined): string[] => (v ?? '').trim().split(/\s+/).filter(Boolean);

export function load(env: NodeJS.ProcessEnv = process.env, slot = 0): Config {
  const databaseUrl = env.TEADIO_DATABASE_URL;
  if (!databaseUrl) throw new Error('TEADIO_DATABASE_URL is required');

  // The machine is the box; the hostname is this process. They are different
  // things — a box runs several slots and they share a disk, which is what
  // makes a machine special. If both defaulted to the system hostname, every
  // slot would upsert one row and fight over its heartbeat, and a dead worker's
  // job would look alive forever.
  const machine = env.TEADIO_MACHINE?.trim() || osHostname();
  const slots = num(env.TEADIO_SLOTS, 1, 'TEADIO_SLOTS');
  if (!Number.isInteger(slots) || slots < 1) throw new Error('TEADIO_SLOTS must be a positive integer');

  const heartbeatMs = num(env.TEADIO_HEARTBEAT_MS, 15_000, 'TEADIO_HEARTBEAT_MS');
  // teadio.stale_after() is 45s in the schema. Heartbeating slower than that
  // means a laptop gets its own live job reclaimed out from under it.
  if (heartbeatMs > 30_000) {
    throw new Error(
      `TEADIO_HEARTBEAT_MS=${heartbeatMs} is too slow; the database reclaims jobs after 45s`,
    );
  }

  const r2Bucket = env.R2_BUCKET?.trim();
  const artifactDir = env.TEADIO_ARTIFACT_DIR?.trim() || null;
  const r2: R2 | null = r2Bucket
    ? {
        bucket: r2Bucket,
        accountId: env.R2_ACCOUNT_ID ?? '',
        accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
      }
    : null;

  if (r2 && (!r2.accountId || !r2.accessKeyId || !r2.secretAccessKey)) {
    throw new Error('R2_BUCKET is set but R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY are not');
  }
  if (!r2 && !artifactDir) {
    throw new Error(
      'No artifact store configured. Set R2_BUCKET (and its keys), or TEADIO_ARTIFACT_DIR ' +
        'for a local directory. A render with nowhere to go is not worth starting.',
    );
  }

  return {
    databaseUrl,
    machine,
    hostname: `${machine}.slot${slot}`,
    slot,
    slots,
    ownerId: env.TEADIO_OWNER_ID?.trim() || null,
    pollMs: num(env.TEADIO_POLL_MS, 2_000, 'TEADIO_POLL_MS'),
    heartbeatMs,
    requireAc: bool(env.TEADIO_REQUIRE_AC, true),
    minFreeDiskGb: num(env.TEADIO_MIN_FREE_DISK_GB, 25, 'TEADIO_MIN_FREE_DISK_GB'),
    runsDir: resolve(env.TEADIO_RUNS_DIR?.trim() || 'runs'),
    renderCmd: argv(env.TEADIO_RENDER_CMD),
    agentCmd: argv(env.TEADIO_AGENT_CMD),
    cdnBase: env.TEADIO_CDN_BASE?.trim().replace(/\/+$/, '') || null,
    artifactDir,
    r2,
  };
}
