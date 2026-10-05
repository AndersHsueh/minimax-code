import { createJobStore, type DaemonJobStore } from './job-store.js';
import { routeJobMethod, type DaemonJobMethods } from './job-methods.js';
import { createCapabilityFile, readCapabilityFile } from './capability.js';
import { connectDaemon, type DaemonClient } from './client.js';
import { daemonPaths } from './paths.js';
import { startDaemonServer, type RunningDaemon } from './server.js';
import { acquireDaemonSingleton } from './singleton.js';
import { createWorkerRegistry } from './worker-registry.js';

/** Exit codes the daemon command uses. */
export const DAEMON_EXIT = {
  ok: 0,
  usage: 2,
  failed: 1,
} as const;

const PERMISSION_MODES = ['default', 'auto', 'bypassPermissions', 'off'] as const;

/**
 * Which `mcode` a worker is spawned with.
 *
 * Production resolves the bare name so a worker is whatever the user installed
 * and upgraded. `MCODE_WORKER_ENTRY` exists so a local verification run spawns
 * the build under test instead of a global binary — otherwise a change here
 * looks like it worked while a different `mcode` served the request.
 *
 * A `.js` path is spawned through the current Node, because a build that was
 * never `npm link`ed is not on PATH and has no shebang to rely on.
 */
function resolveWorkerCommand(): { command?: string; entryArgs?: string[] } {
  const entry = process.env.MCODE_WORKER_ENTRY;
  if (!entry) return {};
  if (entry.endsWith('.js')) return { command: process.execPath, entryArgs: [entry] };
  return { command: entry };
}

export interface DaemonCommandOptions {
  readonly dataDir: string;
  /** Live worker hosts by session id. Injected so tests can supply fakes. */
  readonly workers?: Map<string, WorkerHostLike>;
  readonly permissionMode?: string;
  readonly drain?: boolean;
  /**
   * Starts a worker for an adopted job.
   *
   * Injected rather than constructed here so this module owns no process
   * lifecycle: `mcode daemon run` in Phase 3 kept a map of live hosts, and the
   * hand-off needs the opposite — start nothing until there is work.
   */
  readonly startWorker?: (input: {
    sessionId: string;
    job: Record<string, unknown>;
  }) => Promise<boolean>;
  /** Injected so tests can observe the exit path without ending the process. */
  readonly exit?: (code: number) => Promise<void> | void;
  readonly report?: DaemonCommandReport;
}

export interface DaemonCommandDependencies {
  readonly version: string;
  readonly now?: () => number;
}

export type DaemonStatusReport =
  | { readonly running: false; readonly reason: string }
  | {
      readonly running: true;
      readonly epoch: number;
      readonly socketFile: string;
      readonly daemonVersion: string;
      readonly workers: number;
    };

export type DaemonStopReport = { readonly stopped: true } | { readonly stopped: false; readonly reason: string };

/** Where subcommand output goes. Injected so tests can read it. */
export interface DaemonCommandReport {
  write(line: string): void;
}

const defaultReport: DaemonCommandReport = { write: (line) => process.stdout.write(line) };

export interface DaemonRunHandle {
  readonly started: Promise<{ acquired: boolean; socketFile: string }>;
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

/**
 * `mcode daemon run | status | stop`.
 *
 * The lock is taken before the socket is touched, so a process that loses the
 * race never reaches the socket: it cannot unlink the incumbent's address or
 * bind over it. That loser exits 0 and names the winner — a non-zero exit would
 * read as "the daemon failed to start" and send people hunting a bug that is not
 * there.
 */
export function runDaemonCommand(
  subcommand: 'run',
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): DaemonRunHandle;
export function runDaemonCommand(
  subcommand: 'status',
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): Promise<DaemonStatusReport>;
export function runDaemonCommand(
  subcommand: 'stop',
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): Promise<DaemonStopReport>;
export function runDaemonCommand(
  subcommand: string,
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): DaemonRunHandle | Promise<DaemonStatusReport | DaemonStopReport> {
  switch (subcommand) {
    case 'run':
      return runDaemon(options, dependencies);
    case 'status':
      return daemonStatus(options, dependencies);
    case 'stop':
      return daemonStop(options, dependencies);
    default:
      return Promise.reject(
        new Error(`Unknown \`mcode daemon\` subcommand: ${subcommand}. Use run, status, or stop.`),
      );
  }
}

function runDaemon(
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): DaemonRunHandle {
  const report = options.report ?? defaultReport;
  if (options.permissionMode !== undefined && !isPermissionMode(options.permissionMode)) {
    // The mode is written into a file a later respawn reads verbatim, so a typo
    // would produce a job with no effective permissions and no error.
    return rejected(
      new Error(
        `Unknown --permission-mode: ${options.permissionMode}. Use one of ${PERMISSION_MODES.join(', ')}.`,
      ),
    );
  }
  const paths = daemonPaths(options.dataDir);
  let stopServer: (() => Promise<void>) | undefined;
  let settle: (() => void) | undefined;
  let stopped = false;
  const started = (async () => {
    const singleton = await acquireDaemonSingleton({ dataDir: options.dataDir });
    if (!singleton.acquired) {
      // Losing the race is not a failure. Print who won so the second terminal
      // says "already running, here it is" instead of going quiet, and exit 0 —
      // a non-zero code reads as "the daemon failed to start" and sends people
      // hunting a bug that is not there.
      report.write(describeIncumbent(await probeIncumbent(paths, dependencies.version)));
      await options.exit?.(DAEMON_EXIT.ok);
      return { acquired: false, socketFile: paths.socketFile };
    }
    const token = await createCapabilityFile(paths.capabilityFile);
    const jobs = createJobStore({ dataDir: options.dataDir });
    // The registry owns process lifecycle: it starts a worker only when a job
    // needs one, and it is the thing that can be told which `mcode` to spawn.
    const registry =
      options.workers === undefined && options.startWorker === undefined
        ? createWorkerRegistry({
            jobs,
            dataDir: options.dataDir,
            version: dependencies.version,
            ...resolveWorkerCommand(),
            ...(dependencies.now ? { now: dependencies.now } : {}),
          })
        : undefined;
    const workers = options.workers ?? registry?.workerMap ?? new Map<string, WorkerHostLike>();
    const startWorker = options.startWorker ?? registry?.start;
    const methods = createJobMethods(jobs, workers, options, dependencies, startWorker);
    const server = await startDaemonServer({
      dataDir: options.dataDir,
      token,
      version: dependencies.version,
      epoch: (dependencies.now ?? Date.now)(),
      onStop: () => stopServer?.(),
      countWorkers: () => workers.size,
      handlers: Object.fromEntries(
        JOB_METHODS.map((method) => [
          method,
          (params: unknown, client: { kind: string }) =>
            routeJobMethod(methods, method, params, client),
        ]),
      ),
    });
    stopServer = async () => {
      if (stopped) return;
      stopped = true;
      await server.stop();
      await singleton.release();
      settle?.();
    };
    return { acquired: true, socketFile: server.socketFile };
  })();

  return {
    started,
    // `mcode daemon run` is its own process lifetime: it serves until a signal
    // or an explicit stop, then the socket and the lock are released together so
    // the next start never inherits a half-torn-down singleton.
    done: started.then(
      async (result) => {
        if (!result.acquired) return;
        await new Promise<void>((resolve) => {
          settle = resolve;
          const stop = () => void stopServer?.();
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
          process.once('SIGHUP', stop);
        });
      },
      (error) => {
        void options.exit?.(DAEMON_EXIT.failed);
        throw error;
      },
    ),
    stop: async () => {
      await stopServer?.();
    },
  };
}

async function daemonStatus(
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): Promise<DaemonStatusReport> {
  const paths = daemonPaths(options.dataDir);
  let token: string;
  try {
    token = await readCapabilityFile(paths.capabilityFile);
  } catch {
    // `status` is a diagnostic people run when things look wrong. "not running"
    // has to be an answer, not a stack trace.
    return { running: false, reason: 'No daemon capability token; no daemon has started here.' };
  }
  const client = await connectDaemon({
    socketFile: paths.socketFile,
    token,
    version: dependencies.version,
  }).catch(() => undefined);
  if (!client) {
    return { running: false, reason: `A token exists but nothing is listening on ${paths.socketFile}.` };
  }

  try {
    const status = (await client.request('daemon.status')) as {
      epoch: number;
      socketFile: string;
      daemonVersion: string;
      workers: number;
    };
    return {
      running: true,
      epoch: status.epoch,
      socketFile: status.socketFile,
      daemonVersion: status.daemonVersion,
      workers: status.workers,
    };
  } finally {
    client.close();
  }
}

async function daemonStop(
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): Promise<DaemonStopReport> {
  const paths = daemonPaths(options.dataDir);
  let token: string;
  try {
    token = await readCapabilityFile(paths.capabilityFile);
  } catch (error) {
    return { stopped: false, reason: `No daemon to stop: ${describe(error)}` };
  }
  const client: DaemonClient | undefined = await connectDaemon({
    socketFile: paths.socketFile,
    token,
    version: dependencies.version,
  }).catch(() => undefined);
  if (!client) {
    return {
      stopped: false,
      reason: `The daemon at ${paths.socketFile} did not accept the stop.`,
    };
  }
  try {
    await client.request('daemon.stop', { drain: options.drain === true });
    return { stopped: true };
  } catch (error) {
    return { stopped: false, reason: describe(error) };
  } finally {
    client.close();
  }
}

/** The slice of a worker host the job methods need. */
export interface WorkerHostLike {
  send(input: { sessionId: string; text: string; mode: 'queue' | 'steer' }): Promise<unknown>;
  stop(input: { sessionId: string }): Promise<unknown>;
  remove?(input: { sessionId: string }): Promise<unknown>;
  reply?(
    input: { sessionId: string; interactionId: string; outcome: string },
  ): Promise<unknown>;
  /** §3.9.2 close sequence: cancel, confirm the queue paused, then exit. */
  close?(input: { sessionId: string }): Promise<unknown>;
  /** Liveness for the `✻` vs `∙` distinction, which is *process* liveness. */
  isAlive?(input: { sessionId: string }): boolean;
  /** Whether a Turn is in flight, which decides attach case A vs case B. */
  isBusy?(input: { sessionId: string }): boolean;
  /** Durable tail for the case-B peek surface. */
  peek?(input: { sessionId: string; after?: number }): Promise<readonly unknown[]>;
  /** Starts the worker for a job the foreground TUI just released. */
  start?(input: { sessionId: string; job: Record<string, unknown> }): Promise<boolean>;
}

/** The §3.5 job methods a CLI or TUI client can call. */
export const JOB_METHODS = [
  'jobs.list',
  'job.send',
  'job.stop',
  'job.remove',
  'job.reply',
  'job.adopt',
  'job.attach.begin',
  'job.attach.commit',
  'job.peek',
] as const;

const ENDED_JOB_STATES = new Set(['completed', 'failed', 'stopped']);

function createJobMethods(
  jobs: DaemonJobStore,
  workers: Map<string, WorkerHostLike>,
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
  start?: (input: { sessionId: string; job: Record<string, unknown> }) => Promise<boolean>,
): DaemonJobMethods {
  return {
    jobs,
    listJobs: async (input) => {
      const rows: Record<string, unknown>[] = [];
      for (const sessionId of await jobs.listJobs()) {
        const job = await jobs.readJob(sessionId);
        if (!job) continue;
        if (!input.includeEnded && ENDED_JOB_STATES.has(String(job.state ?? 'idle'))) continue;
        rows.push({ ...job, sessionId });
      }
      return rows;
    },
    // A session with no worker is the normal case between messages, not an
    // error: the process is a cache, so `send` wakes it and then delivers. Only
    // a worker that will not come up at all stages the message.
    send: async (input) => {
      let worker = workers.get(input.sessionId);
      if (!worker) {
        const job = await jobs.readJob(input.sessionId);
        if (job) {
          await startWorker(input.sessionId, job);
          worker = workers.get(input.sessionId);
          // Anything staged while this session had no worker goes first, so a
          // respawn after a crash does not reorder the conversation. The current
          // message is skipped: the store has not staged it yet, and sending it
          // twice would be worse than out of order.
          for (const staged of await jobs.listPending(input.sessionId)) {
            try {
              await worker?.send({ ...input, text: staged.text });
              await jobs.resolvePending(input.sessionId, staged.id);
            } catch {
              break;
            }
          }
        }
      }
      if (!worker) throw new Error('No worker is running for this session.');
      return worker.send(input);
    },
    stop: async (input) => {
      const worker = workers.get(input.sessionId);
      if (!worker) throw new Error('No worker is running for this session.');
      return worker.stop(input);
    },
    remove: async () => ({ removed: true }),
    reply: async (input) => {
      const worker = workers.get(input.sessionId);
      if (!worker?.reply) return { rejected: 'unknown-interaction' as const };
      return (await worker.reply(input)) as { rejected: 'rejected' };
    },
    adopt: async (input) => {
      // A job already owned by a live TUI cannot be adopted. Two owners both
      // write turns to the same transcript, and the second one to think it owns
      // the session is the one that loses work.
      const existing = await jobs.readJob(input.sessionId);
      if (existing?.attachedPid !== undefined && Number(existing.attachedPid) > 0) {
        return { adopted: false as const, reason: 'busy' as const };
      }
      const job = {
        ...(existing ?? {}),
        proto: 1,
        sessionId: input.sessionId,
        state: 'idle',
        origin: 'background',
        launch: input.launch,
        handoff: input.handoff,
        // Kept from the earlier record when this adopt does not name one: a
        // worker that loses the workspace cannot load its own session.
        cwd: input.cwd ?? (existing as { cwd?: unknown } | undefined)?.cwd,
        attachedPid: undefined,
        adoptedAt: (dependencies.now ?? Date.now)(),
      };
      await jobs.writeJob(job);
      // The process is a cache (§2.2). An idle hand-off has nothing to do, so
      // it records the job and starts nothing; a resumed Turn has to start one.
      const workerStarted = input.handoff.continue ? await startWorker(input.sessionId, job) : false;
      await jobs.appendTimeline(input.sessionId, {
        at: (dependencies.now ?? Date.now)(),
        state: workerStarted ? 'working' : 'idle',
        detail: 'handoff-committed',
      });
      return { adopted: true as const, workerStarted };
    },
    attach: async (input) => {
      const job = await jobs.readJob(input.sessionId);
      if (job?.attachedPid !== undefined && Number(job.attachedPid) > 0) {
        // Ownership is one holder at a time (§3.7).
        return { owner: 'none' as const, live: false, reason: 'already-attached' as const };
      }
      const worker = workers.get(input.sessionId);
      if (worker?.isBusy?.(input) === true) {
        // Case B: the worker still holds a Turn. Closing it now would abort work
        // in flight, so the TUI opens a read-only peek and queues messages.
        return { owner: 'worker' as const, live: true };
      }
      // Case A: shut the worker down through the safe sequence before handing
      // over, so the next foreground process starts from a settled transcript.
      if (worker?.close) await worker.close(input);
      workers.delete(input.sessionId);
      return { owner: 'client' as const, live: false };
    },
    attachCommit: async (input) => {
      const job = await jobs.readJob(input.sessionId);
      if (!job) return { attached: false };
      // The PID is the only way the daemon learns this driver died. A commit
      // without it leaves the job permanently attached to nothing, and the
      // session is unreachable even though its history is intact in the DB.
      await jobs.updateJob(input.sessionId, {
        state: 'attached',
        attachedPid: process.pid,
        attachedAt: (dependencies.now ?? Date.now)(),
      });
      return { attached: true };
    },
    peek: async (input) => {
      const worker = workers.get(input.sessionId);
      // Both sources, merged: the durable timeline survives a worker that died,
      // and the live worker's own events carry the Turn that is running now.
      // Preferring one over the other loses half the history — preferring the
      // worker alone shows an empty tail for a session that was just started,
      // which reads as "nothing happened".
      const [timeline, live] = await Promise.all([
        jobs.readTimeline(input.sessionId),
        (worker?.peek?.(input) ?? Promise.resolve([])) as Promise<readonly unknown[]>,
      ]);
      const merged = [...timeline, ...live].sort(
        (left, right) => Number((left as { at?: unknown }).at ?? 0) - Number((right as { at?: unknown }).at ?? 0),
      );
      // Liveness is the process, never the last recorded state. Reporting
      // `live: true` for a dead worker would put the user in a view that only
      // ever repaints.
      return {
        owner: worker ? ('worker' as const) : ('client' as const),
        live: worker?.isAlive?.(input) === true,
        events: merged,
      };
    },
  };

  async function startWorker(
    sessionId: string,
    job: Record<string, unknown>,
  ): Promise<boolean> {
    const existing = workers.get(sessionId);
    if (existing) return true;
    // Started lazily: a job whose worker cannot start must still be recorded so
    // the row shows why, and a message sent before the worker is up stays staged.
    if (!start) return false;
    const started = await start({ sessionId, job });
    return started;
  }
}

async function probeIncumbent(  paths: ReturnType<typeof daemonPaths>,
  version: string,
): Promise<string> {
  let token: string;
  try {
    token = await readCapabilityFile(paths.capabilityFile);
  } catch {
    return `another daemon holds ${paths.lockFile} but is not reachable yet; retry in a moment`;
  }
  const client = await connectDaemon({ socketFile: paths.socketFile, token, version }).catch(
    () => undefined,
  );
  if (!client) return `another daemon already holds ${paths.lockFile}`;
  try {
    const status = (await client.request('daemon.status')) as { epoch: number; daemonVersion: string };
    return `daemon already running (epoch ${status.epoch}, version ${status.daemonVersion}, ${paths.socketFile})`;
  } catch {
    return `another daemon already holds ${paths.lockFile}`;
  } finally {
    client.close();
  }
}

function describeIncumbent(line: string): string {
  return `${line}\n`;
}

function isPermissionMode(value: string): boolean {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejected(error: Error): DaemonRunHandle {
  return {
    started: Promise.reject(error),
    done: Promise.resolve(),
    stop: async () => undefined,
  };
}

export type { RunningDaemon };
