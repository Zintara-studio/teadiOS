// Entry point. One container per laptop; N slots inside it.
//
// Slot 0 runs in this process and the rest are forked, so `docker run` once per
// machine is the whole story. Every slot registers its own row — they share a
// machine, and that is what jobs pin to.

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { load } from './config.ts';
import { runSlot } from './worker.ts';

const slot = Number(process.env.TEADIO_SLOT ?? 0);
const cfg = load(process.env, slot);

const controller = new AbortController();
const children = new Set<ReturnType<typeof fork>>();

const stop = (signal: NodeJS.Signals): void => {
  process.stdout.write(`\n${cfg.hostname} stopping on ${signal}\n`);
  controller.abort();
  for (const child of children) child.kill(signal);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

// Only the first process forks; the children are told which slot they are.
if (slot === 0 && cfg.slots > 1) {
  const self = fileURLToPath(import.meta.url);
  for (let i = 1; i < cfg.slots; i++) {
    const child = fork(self, { env: { ...process.env, TEADIO_SLOT: String(i) } });
    children.add(child);
    child.on('exit', () => children.delete(child));
  }
}

try {
  await runSlot(cfg, controller.signal);
} catch (err) {
  process.stderr.write(`${cfg.hostname} died: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill('SIGTERM');
}
