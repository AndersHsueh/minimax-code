import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runDaemonCommand, DAEMON_EXIT } from '../packages/tui/src/daemon/command.js';
import { createCapabilityFile } from '../packages/tui/src/daemon/capability.js';
import { daemonPaths } from '../packages/tui/src/daemon/paths.js';
import { buildDaemonSpawn } from '../packages/tui/src/daemon/launch.js';

/**
 * Phase 2 contract: `mcode daemon run | status | stop`.
 *
 * The behaviour that matters is the losing case. A user pressing the same key
 * twice, or two terminals racing on first use, must not produce two daemons
 * fighting over the same dataDir — and the loser must exit **0** and say who won.
 * A non-zero exit reads as "the daemon failed to start", which sends people
 * looking for a bug that does not exist.
 *
 * Launching is the other half. A daemon that inherits the terminal's session
 * dies with it: closing the tab sends SIGHUP to the process group, taking the
 * daemon and every worker with it. That is the whole reason for `detached` plus
 * redirected stdio plus `unref` — and the token must not ride along in `env`,
 * where the same user could read it out of `/proc`.
 *
 * See mydocs/supervisor-plan-v2.md §3.6 and the `mcode daemon` acceptance list.
 */
describe('mcode daemon command', () => {
  const roots: string[] = [];
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((stop) => stop().catch(() => undefined)));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-cmd-'));
    roots.push(dir);
    return dir;
  }

  function harness(overrides: Partial<Parameters<typeof runDaemonCommand>[1]> = {}) {
    const deps = {
      version: '9.9.9',
      now: () => 1_700_000_000_000,
      spawnProcess: vi.fn(() => ({ pid: 4321, unref: vi.fn() })),
      isProcessAlive: () => true,
      readProcessStartToken: async () => ({ token: 'start-token' }),
      ...overrides,
    };
    return { deps };
  }

  it('takes the lock, writes the token, and serves when it is the first', async () => {
    const dataDir = await tempDataDir();
    const { deps } = harness();
    const exit = vi.fn(async () => undefined);

    const run = runDaemonCommand('run', { dataDir, exit }, deps);
    // The command serves until stopped; drive it through its handle.
    await expect(run.started).resolves.toMatchObject({ acquired: true });
    expect(exit).not.toHaveBeenCalled();

    await run.stop();
    await run.done;
    // The daemon serves in-process; it never re-spawns itself.
    expect(deps.spawnProcess).not.toHaveBeenCalled();
  });

  it('exits 0 and names the incumbent when another daemon holds the lock', async () => {
    // Found by running the built CLI, not by a unit test: the loser exited 0
    // correctly but printed nothing, so a user in a second terminal got no
    // indication of which daemon they are supposed to talk to.
    const dataDir = await tempDataDir();
    const exit = vi.fn();
    const report = { write: vi.fn() };
    const first = runDaemonCommand('run', { dataDir, exit, report }, harness().deps);
    await first.started;
    cleanups.push(first.stop);

    const secondExit = vi.fn();
    const second = runDaemonCommand('run', { dataDir, exit: secondExit, report }, harness().deps);
    await expect(second.started).resolves.toMatchObject({ acquired: false });
    await second.done;

    expect(secondExit).toHaveBeenCalledWith(DAEMON_EXIT.ok);
    const printed = report.write.mock.calls.map((call) => String(call[0])).join('');
    expect(printed).toMatch(/already running|already holds/);
    // The address the second terminal needs is the socket, not the lock.
    expect(printed).toContain(daemonPaths(dataDir).socketFile);

    await first.stop();
  });

  it('stops the daemon over the socket', async () => {
    // Also found by running the built CLI: `daemon stop` reached the daemon and
    // got "Unknown method", because `daemon.stop` had no handler.
    const dataDir = await tempDataDir();
    const running = runDaemonCommand('run', { dataDir, exit: vi.fn() }, harness().deps);
    await running.started;
    cleanups.push(running.stop);

    await expect(runDaemonCommand('stop', { dataDir }, harness().deps)).resolves.toEqual({
      stopped: true,
    });
    await running.done;

    await expect(runDaemonCommand('status', { dataDir }, harness().deps)).resolves.toMatchObject({
      running: false,
    });
  });

  it('accepts a drain request even with nothing to drain', async () => {
    const dataDir = await tempDataDir();
    const running = runDaemonCommand('run', { dataDir, exit: vi.fn() }, harness().deps);
    await running.started;
    cleanups.push(running.stop);

    await expect(
      runDaemonCommand('stop', { dataDir, drain: true }, harness().deps),
    ).resolves.toEqual({ stopped: true });
    await running.done;
  });

  it('reports a healthy daemon for status', async () => {
    const dataDir = await tempDataDir();
    const running = runDaemonCommand('run', { dataDir, exit: vi.fn() }, harness().deps);
    await running.started;
    cleanups.push(running.stop);

    const report = await runDaemonCommand('status', { dataDir }, harness().deps);

    expect(report).toMatchObject({ running: true, epoch: expect.any(Number) });
    expect(report?.socketFile).toBe(daemonPaths(dataDir).socketFile);
  });

  it('reports a stopped daemon without throwing when there is none', async () => {
    const dataDir = await tempDataDir();
    // `mcode daemon status` is a diagnostic people run when things look wrong.
    // "not running" has to be an answer, not a stack trace.
    const report = await runDaemonCommand('status', { dataDir }, harness().deps);
    expect(report).toMatchObject({ running: false });
  });

  it('refuses to stop a daemon it cannot reach', async () => {
    const dataDir = await tempDataDir();
    const report = await runDaemonCommand('stop', { dataDir }, harness().deps);
    expect(report).toMatchObject({ stopped: false, reason: expect.any(String) });
  });

  it('rejects an unknown subcommand instead of guessing', async () => {
    const dataDir = await tempDataDir();
    await expect(
      runDaemonCommand('restart', { dataDir }, harness().deps),
    ).rejects.toThrow(/restart/);
  });

  it('refuses a permission mode it does not know', async () => {
    // The mode is written into a file a later respawn reads verbatim; accepting a
    // typo would silently produce a job with no effective permissions.
    const dataDir = await tempDataDir();
    const handle = runDaemonCommand('run', { dataDir, permissionMode: 'skipEverything' }, harness().deps);
    await expect(handle.started).rejects.toThrow(/permission/i);
  });
});

describe('daemon launch', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempDataDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-launch-'));
    roots.push(dir);
    return dir;
  }

  it('detaches the daemon from the terminal that started it', () => {
    // Without `detached`, closing the tab SIGHUPs the process group and takes the
    // daemon and every worker with it.
    const spawn = buildDaemonSpawn({ dataDir: '/data', entry: '/cli.js', logFd: 3 });
    expect(spawn).toMatchObject({ detached: true, cwd: '/data' });
  });

  it('redirects stdio to the log rather than inheriting the TUI', () => {
    // Inheriting the terminal's stdio both corrupts the TUI and gives the daemon
    // a controlling terminal it can be signalled through.
    const spawn = buildDaemonSpawn({ dataDir: '/data', entry: '/cli.js', logFd: 3 });
    expect(spawn.stdio).toEqual(['ignore', 3, 3]);
  });

  it('keeps the capability token out of the environment', () => {
    // Anything in `env` is readable from `/proc/<pid>/environ` by the same user
    // and inherited by every child the daemon spawns.
    const spawn = buildDaemonSpawn({
      dataDir: '/data',
      entry: '/cli.js',
      logFd: 3,
      env: { PATH: '/usr/bin', MCODE_DAEMON_TOKEN: 'leaked' },
    });
    expect(Object.keys(spawn.env)).not.toContain('MCODE_DAEMON_TOKEN');
    expect(JSON.stringify(spawn.env)).not.toContain('leaked');
    // The dataDir override is the one variable that must survive.
    expect(spawn.env.MINIMAX_DATA_DIR).toBe('/data');
  });

  it('runs the daemon entry, not an interactive shell', () => {
    const spawn = buildDaemonSpawn({ dataDir: '/data', entry: '/cli.js', logFd: 3 });
    expect(spawn.args).toEqual(['/cli.js', 'daemon', 'run']);
  });

  it('keeps the data dir resolvable so the child finds its own state', () => {
    // The child derives its socket and lock from the dataDir; if the override is
    // dropped the daemon silently starts a second, isolated instance.
    const spawn = buildDaemonSpawn({ dataDir: '/data', entry: '/cli.js', logFd: 3 });
    expect(spawn.env?.MINIMAX_DATA_DIR ?? spawn.env?.MAVIS_DATA_DIR).toBe('/data');
  });

  it('rotates the log instead of letting it grow forever', async () => {
    const dataDir = await tempDataDir();
    const logsDir = daemonPaths(dataDir).logsDir;
    await writeFile(join(logsDir, 'daemon.log'), 'old line\n', { flag: 'a' }).catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(logsDir, { recursive: true });
      await writeFile(join(logsDir, 'daemon.log'), 'old line\n');
    });

    const { rotateDaemonLog } = await import('../packages/tui/src/daemon/logging.js');
    const rotated = await rotateDaemonLog(join(logsDir, 'daemon.log'), 5);

    expect(rotated).toBe(true);
    expect(await readFile(join(logsDir, 'daemon.log.1'), 'utf8')).toContain('old line');
  });

  it('leaves a small log alone', async () => {
    const dataDir = await tempDataDir();
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    const logsDir = daemonPaths(dataDir).logsDir;
    await mkdir(logsDir, { recursive: true });
    const file = join(logsDir, 'daemon.log');
    await wf(file, 'small\n');

    const { rotateDaemonLog } = await import('../packages/tui/src/daemon/logging.js');
    await expect(rotateDaemonLog(file, 10)).resolves.toBe(false);
    expect(await readFile(file, 'utf8')).toBe('small\n');
  });
});
