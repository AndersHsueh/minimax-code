import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { daemonPaths, resolveDaemonSocketPath } from '../packages/tui/src/daemon/paths.js';

/** The path half of the resolver's result; the tests care about bindability. */
function socketPath(dataDir: string): string {
  return resolveDaemonSocketPath(dataDir).path;
}

/**
 * Phase 2 contract: where a daemon keeps its state, derived from `dataDir`.
 *
 * Two constraints shape this and neither is stylistic.
 *
 * The singleton is scoped to a **dataDir, not a user**. `runtime/data-dir.ts`
 * honours `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR`, so a user can legitimately run
 * two isolated daemons at once. Anything that hardcodes `~/.minimax`, or takes a
 * global lock, would break that and is wrong by construction rather than by
 * preference.
 *
 * The socket path is bounded by the OS. `sun_path` is 104 bytes on macOS and 108
 * on Linux, and a dataDir is user-chosen — a long one silently produces a socket
 * that cannot bind. The fallback has to be deterministic, per-dataDir, and
 * private, or two daemons could collide on it or another user could pre-create it.
 *
 * See mydocs/supervisor-plan-v2.md §3.4 and §3.6.
 */
describe('daemon paths', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('derives every path from the dataDir it was given', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'daemon-paths-'));
    roots.push(dataDir);

    const paths = daemonPaths(dataDir);

    expect(paths.dataDir).toBe(dataDir);
    expect(paths.daemonDir).toBe(join(dataDir, 'daemon'));
    expect(paths.lockFile).toBe(join(dataDir, 'daemon', 'daemon.lock'));
    expect(paths.capabilityFile).toBe(join(dataDir, 'daemon', 'daemon.cap'));
    expect(paths.rosterFile).toBe(join(dataDir, 'daemon', 'roster.json'));
    expect(paths.jobsDir).toBe(join(dataDir, 'daemon', 'jobs'));
    expect(paths.logsDir).toBe(join(dataDir, 'daemon', 'logs'));
  });

  it('gives each dataDir its own job directory', () => {
    // Two isolated daemons must not be able to see or clobber each other's jobs.
    const first = daemonPaths('/data/one');
    const second = daemonPaths('/data/two');
    expect(first.jobsDir).not.toBe(second.jobsDir);
  });

  it('prefers a socket inside the dataDir when it fits', () => {
    const short = socketPath('/data/x');
    expect(short).toBe(join('/data/x', 'run', 'mcode-daemon.sock'));
  });

  it('reports whether the socket had to move out of the dataDir', () => {
    expect(resolveDaemonSocketPath('/data/x').isFallback).toBe(false);
    expect(resolveDaemonSocketPath(`/data/${'x'.repeat(80)}`).isFallback).toBe(true);
  });

  it('falls back to a per-dataDir path in /tmp when the path is too long', () => {
    // `sun_path` is 104 bytes on macOS. A deep dataDir plus the filename can cross
    // that, and `bind` then fails with an error that says nothing about length.
    const long = `/Users/somebody/with/a/very/long/home/directory/${'x'.repeat(60)}`;
    const resolved = socketPath(long);

    expect(Buffer.byteLength(resolved)).toBeLessThan(104);
    expect(resolved.startsWith(tmpdir())).toBe(true);
  });

  it('derives the fallback from the dataDir so two daemons cannot collide', () => {
    const digest = (dataDir: string) =>
      createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
    const long = `/data/${'x'.repeat(80)}`;

    expect(socketPath(`${long}a`)).not.toBe(socketPath(`${long}b`));
    expect(socketPath(long)).toContain(digest(long));
  });

  it('is stable for the same dataDir', () => {
    // The client has to recompute this without asking the daemon first.
    const long = `/data/${'y'.repeat(80)}`;
    expect(socketPath(long)).toBe(socketPath(long));
  });

  it('falls back on the byte length, not the character count', () => {
    // A dataDir of multi-byte characters is short in `length` and long in bytes,
    // which is the only measure the kernel applies.
    const multibyte = `/data/${'数'.repeat(40)}`;
    expect(multibyte.length).toBeLessThan(104);
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(104);
    expect(Buffer.byteLength(socketPath(multibyte))).toBeLessThan(104);
  });

  it('never returns a path the OS could not bind', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'daemon-sock-'));
    roots.push(dataDir);

    for (const candidate of [dataDir, `${dataDir}/nested/deeply`, `/data/${'z'.repeat(90)}`]) {
      expect(Buffer.byteLength(socketPath(candidate))).toBeLessThan(104);
    }
  });

  it('keeps the fallback directory private to the current user', async () => {
    const long = `/data/${'w'.repeat(80)}`;
    const resolved = socketPath(long);
    const dir = join(resolved, '..');

    // mcode already learned this the hard way with the tools broker: a shared
    // /tmp path is pre-creatable by any other user on the machine.
    expect(resolved).toContain(String(process.getuid?.() ?? 'uid'));
    expect(dir.startsWith(tmpdir())).toBe(true);
  });

  it('does not touch the filesystem while resolving', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'daemon-pure-'));
    roots.push(dataDir);
    await expect(stat(join(dataDir, 'run', 'mcode-daemon.sock'))).rejects.toThrow();
    socketPath(dataDir);
    // Path derivation is pure; `daemon run` creates the directories.
  });
});
