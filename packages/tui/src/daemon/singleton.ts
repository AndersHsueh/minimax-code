import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import lockfile from 'proper-lockfile';

import { daemonPaths } from './paths.js';

export interface AcquireDaemonSingletonOptions {
  readonly dataDir: string;
  /** How long a lock survives without a heartbeat before another process may take
   *  it. Long enough that a busy daemon never loses its own lock, short enough
   *  that `kill -9` does not wedge the dataDir. */
  readonly staleMs?: number;
  readonly updateMs?: number;
  readonly onCompromised?: (error: Error) => void;
}

export interface DaemonSingleton {
  readonly acquired: boolean;
  readonly lockFile: string;
  /** Idempotent. */
  release(): Promise<void>;
}

/**
 * Takes the dataDir's daemon lock, or reports that someone else holds it.
 *
 * The lock is taken *before* the caller touches the socket file, which is the
 * entire point: a process that loses the race never reaches the socket, so it
 * cannot unlink the incumbent's address or bind over it. The auth-lease broker
 * inverts this ("unlink, then listen") and is therefore last-writer-wins.
 *
 * A refusal is `acquired: false`, never a throw, so `mcode daemon run` can exit 0
 * and point at the daemon that won.
 */
export async function acquireDaemonSingleton(
  options: AcquireDaemonSingletonOptions,
): Promise<DaemonSingleton> {
  const paths = daemonPaths(options.dataDir);
  const staleMs = options.staleMs ?? 60_000;
  // `proper-lockfile` clamps `stale` to >= 2000 and `update` to >= 1000, so
  // asking for less is silently ignored. Ask for what we mean.
  const updateMs = options.updateMs ?? Math.max(1_000, Math.floor(staleMs / 2));
  let release: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(paths.lockFile), { recursive: true, mode: 0o700 });
    // `proper-lockfile` appends `.lock` to whatever it is given, and creates the
    // artifact with `fs.mkdir` — so the lock is a *directory*, not a file.
    // Pinning `lockfilePath` keeps it at exactly the documented
    // `<dataDir>/daemon/daemon.lock` instead of `daemon.lock.lock`.
    release = await lockfile.lock(paths.daemonDir, {
      realpath: false,
      lockfilePath: paths.lockFile,
      stale: staleMs,
      update: updateMs,
      retries: 0,
      ...(options.onCompromised ? { onCompromised: options.onCompromised } : {}),
    });
  } catch {
    // ELOCKED and every other refusal mean the same thing to a caller: the
    // singleton is not ours. `proper-lockfile` throws rather than returning null.
    return { acquired: false, lockFile: paths.lockFile, release: async () => undefined };
  }
  let released = false;
  return {
    acquired: true,
    lockFile: paths.lockFile,
    release: async () => {
      if (released) return;
      released = true;
      const current = release;
      release = undefined;
      await current?.().catch(() => undefined);
    },
  };
}
