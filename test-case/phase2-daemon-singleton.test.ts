import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireDaemonSingleton } from '../packages/tui/src/daemon/singleton.js';
import { daemonPaths } from '../packages/tui/src/daemon/paths.js';

/**
 * Phase 2 contract: exactly one daemon per dataDir.
 *
 * The order is the whole design and it is the reverse of the obvious one:
 *
 *  1. take the `proper-lockfile` lock
 *  2. *then* deal with the socket file
 *
 * The auth-lease broker does "unlink the socket, then listen", which is
 * last-writer-wins — the newcomer binds over the incumbent's socket and both
 * processes then believe they own the dataDir. With a lock first, the loser never
 * reaches the socket, and it can say who won instead of fighting for it.
 *
 * The subtle failure is a `kill -9`. The dead process leaves its socket file
 * behind, and its lock becomes stale only after the stale window. A restart inside
 * that window must neither steal the socket of a *new* daemon nor unlink a socket
 * it does not own — an unlink by a non-owner is how a live daemon silently loses
 * its address and becomes unreachable.
 *
 * See mydocs/supervisor-plan-v2.md §3.6, and the guardrail "only the lock holder
 * may unlink the socket".
 */
describe('daemon singleton', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-single-'));
    roots.push(dir);
    return dir;
  }

  it('grants the lock to the first caller', async () => {
    const dataDir = await tempDataDir();
    const first = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });

    expect(first.acquired).toBe(true);
    await first.release();
  });

  it('refuses a second holder while the first is alive', async () => {
    const dataDir = await tempDataDir();
    const first = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });
    const second = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });

    expect(second.acquired).toBe(false);
    await first.release();
  });

  it('grants the lock again after the holder releases it', async () => {
    const dataDir = await tempDataDir();
    const first = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });
    await first.release();

    const second = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });
    expect(second.acquired).toBe(true);
    await second.release();
  });

  it('scopes the lock to the dataDir, not to the user', async () => {
    // A user may run isolated daemons on purpose; a global lock would forbid it.
    const [one, two] = await Promise.all([tempDataDir(), tempDataDir()]);
    const first = await acquireDaemonSingleton({ dataDir: one, staleMs: 30_000 });
    const second = await acquireDaemonSingleton({ dataDir: two, staleMs: 30_000 });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    await first.release();
    await second.release();
  });

  it('marks the lock with a directory, the way proper-lockfile does', async () => {
    // Not incidental: `acquireLock` uses `fs.mkdir`, so the artifact is a
    // directory. Anything that cleans up the dataDir has to remove it with
    // `recursive`, and a "stale lock file" is a stale lock *directory*.
    const dataDir = await tempDataDir();
    const holder = await acquireDaemonSingleton({ dataDir });
    expect((await stat(holder.lockFile)).isDirectory()).toBe(true);
    await holder.release();
  });

  it('reports the lock file it used so the loser can name the winner', async () => {
    const dataDir = await tempDataDir();
    const first = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });
    const second = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });

    expect(second.acquired).toBe(false);
    expect(second.lockFile).toBe(daemonPaths(dataDir).lockFile);
    await first.release();
  });

  it('refuses a lock rather than waiting forever by default', async () => {
    const dataDir = await tempDataDir();
    const first = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });

    const started = Date.now();
    const second = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });
    expect(second.acquired).toBe(false);
    // A CLI that blocks here looks like a hang, not like "already running".
    expect(Date.now() - started).toBeLessThan(5_000);
    await first.release();
  });

  it('rejects an immediate retry when the live lock refuses it', async () => {
    // `proper-lockfile` throws ELOCKED rather than returning null. Callers must
    // see `acquired: false`, not an exception, so `mcode daemon run` can exit 0
    // and point at the incumbent.
    const dataDir = await tempDataDir();
    const first = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });
    await expect(acquireDaemonSingleton({ dataDir, staleMs: 30_000 })).resolves.toMatchObject({
      acquired: false,
    });
    await first.release();
  });

  it('treats a lock left by a killed process as acquirable once it goes stale', async () => {
    // A crash must not wedge the dataDir forever. `proper-lockfile` decides
    // staleness from the lock file's mtime, because the heartbeat is an mtime
    // touch — so backdating the file is exactly what a `kill -9` leaves behind,
    // and no test-only crash hook is needed to reproduce it.
    const dataDir = await tempDataDir();
    const crashed = await acquireDaemonSingleton({ dataDir });
    const before = await stat(crashed.lockFile);
    // `proper-lockfile` clamps `stale` to 2000ms and compares mtime strictly, so
    // backdate well past the default window.
    const longAgo = new Date(before.mtimeMs - 120_000);
    await utimes(crashed.lockFile, longAgo, longAgo);

    const restarted = await acquireDaemonSingleton({ dataDir });
    expect(restarted.acquired).toBe(true);
    await restarted.release();
  });

  it('reports lock loss instead of pretending it still holds the singleton', async () => {
    // `proper-lockfile` calls `onCompromised` when it finds the lock file it
    // owns was replaced underneath it. A daemon that ignored that would keep
    // serving as "the one daemon" while a second one is live and reachable.
    const dataDir = await tempDataDir();
    let reported = 0;
    const holder = await acquireDaemonSingleton({
      dataDir,
      // `update` is clamped to >= 1000ms and `stale` to >= 2000ms, so the
      // compromise cannot be observed faster than that.
      staleMs: 2_000,
      updateMs: 1_000,
      onCompromised: () => {
        reported += 1;
      },
    });

    // Deleting the lock file is what `proper-lockfile` treats as compromise;
    // overwriting it only changes the mtime, which it is happy to reclaim.
    await rm(holder.lockFile, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 2_600));

    expect(reported).toBeGreaterThan(0);
    await holder.release();
  });

  it('is idempotent on release', async () => {
    const dataDir = await tempDataDir();
    const holder = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });

    await holder.release();
    await expect(holder.release()).resolves.toBeUndefined();

    // And the lock is genuinely free afterwards.
    const next = await acquireDaemonSingleton({ dataDir, staleMs: 30_000 });
    expect(next.acquired).toBe(true);
    await next.release();
  });
});
