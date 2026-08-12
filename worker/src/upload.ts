// The artifact goes to storage BEFORE the job is called done. A completed job
// whose only copy is on the laptop that made it is the failure this system
// exists to prevent, so an upload that throws must fail the run.

import { AwsClient } from 'aws4fetch';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from './config.ts';

export type Uploaded = { url: string; bytes: number };

/**
 * Two real backends, no plugin system. R2 (or any S3-compatible bucket) is the
 * normal one; a local directory covers a single-machine trial or a mounted
 * network share, and is what the tests exercise.
 */
export async function upload(local: string, key: string, cfg: Config): Promise<Uploaded> {
  const { size } = await stat(local);
  if (size === 0) throw new Error(`refusing to upload an empty file: ${local}`);

  if (cfg.artifactDir) {
    const dest = join(cfg.artifactDir, key);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(local, dest);
    return { url: cfg.cdnBase ? `${cfg.cdnBase}/${key}` : `file://${dest}`, bytes: size };
  }

  const r2 = cfg.r2!;
  const client = new AwsClient({
    accessKeyId: r2.accessKeyId,
    secretAccessKey: r2.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  const endpoint = `https://${r2.accountId}.r2.cloudflarestorage.com/${r2.bucket}/${key}`;
  const res = await client.fetch(endpoint, {
    method: 'PUT',
    body: createReadStream(local),
    // Node needs this to stream a body rather than buffer the whole video.
    duplex: 'half',
    headers: {
      'content-length': String(size),
      'content-type': 'video/mp4',
    },
  } as RequestInit);

  if (!res.ok) {
    throw new Error(`upload failed: ${res.status} ${res.statusText} ${(await res.text()).slice(0, 300)}`);
  }
  return { url: cfg.cdnBase ? `${cfg.cdnBase}/${key}` : endpoint, bytes: size };
}
