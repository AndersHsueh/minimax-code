import type { WorkerHostLike } from './command.js';
import type { DaemonJobStore, PendingMessage } from './job-store.js';
import { createWorkerHost, type WorkerHostJob } from './worker-host.js';

/**
 * The worker registry: the missing link between `mcode daemon run` and
 * {@link createWorkerHost}.
 *
 * The host itself is complete — it spawns `mcode acp`, speaks the conversation,
 * derives state, and recovers from crashes. What was never written is the part
 * that owns those hosts: something has to decide *when* a job gets a worker,
 * route a `job.send` to it, and replay what the store staged while it was gone.
 *
 * Three rules from §2.2 and §3.7.1 shape everything here:
 *
 *  - A worker is started from the job file's own launch record, never from the
 *    global config. `resolveWorkerLaunch` throws rather than falling back, so a
 *    job whose record is unusable fails loudly instead of quietly inheriting
 *    whatever mode the user last set in another terminal.
 *  - A message that cannot be delivered is staged, not dropped. A dropped
 *    message loses work the user believes was sent.
 *  - `mcode/session/queue/enqueue` is never used to start a turn. §5.6.3 leaves
 *    that unverified (it goes through `turn.submit({allowQueue:true})` and
 *    requires a `queued` result), so an idle worker is given `session/prompt`.
 */

export interface WorkerRegistryOptions {
  readonly jobs: DaemonJobStore;
  readonly dataDir: string;
  /**
   * The `mcode` executable a worker is spawned with.
   *
   * Defaults to the bare name so a production daemon resolves whatever the user
   * installed. Tests and local verification pass an absolute path to the build
   * under test, because a global `mcode` on PATH would make a change here look
   * like it worked while running a different binary.
   */
  readonly command?: string;
  readonly entryArgs?: readonly string[];
  readonly version: string;
  readonly now?: () => number;
}

export interface WorkerRegistry {
  readonly start: (input: {
    sessionId: string;
    job: Record<string, unknown>;
  }) => Promise<boolean>;
  readonly get: (sessionId: string) => WorkerHostLike | undefined;
  /**
   * The live workers keyed by session id.
   *
   * This is the *same* map instance for the registry's whole life, not a copy:
   * the daemon captures it once at startup and every later `job.send` reads it,
   * so a copy would go stale the moment a second worker started.
   */
  readonly workerMap: Map<string, WorkerHostLike>;
  readonly size: () => number;
  /** One supervisor pass: refresh activity, then reclaim idle workers. */
  readonly tick: () => Promise<void>;
  readonly stopAll: (options: { drain: boolean }) => Promise<void>;
}

export function createWorkerRegistry(options: WorkerRegistryOptions): WorkerRegistry {
  const hosts = new Map<string, { host: ReturnType<typeof createWorkerHost>; worker: WorkerHostLike }>();
  /** The one map the daemon holds. Mutated in place as workers come and go. */
  const workers = new Map<string, WorkerHostLike>();
  const ready = new Map<string, Promise<void>>();

  return {
    start: (input) => startWorker(input.sessionId, input.job),
    get: (sessionId) => hosts.get(sessionId)?.worker,
    workerMap: workers,
    size: () => hosts.size,
    tick: async () => {
      for (const { host } of [...hosts.values()]) {
        await host.tick().catch(() => undefined);
      }
    },
    stopAll: async (stopOptions) => {
      for (const [sessionId, { host, worker }] of [...hosts.entries()]) {
        if (stopOptions.drain && host.state().promptInFlight) continue;
        await host.stop().catch(() => undefined);
        hosts.delete(sessionId);
        workers.delete(sessionId);
      }
    },
  };

  async function startWorker(
    sessionId: string,
    job: Record<string, unknown>,
  ): Promise<boolean> {
    if (hosts.has(sessionId)) return true;
    const inFlight = ready.get(sessionId);
    if (inFlight) {
      await inFlight.catch(() => undefined);
      return hosts.has(sessionId);
    }

    const attempt = (async () => {
      if (process.env.MCODE_WORKER_TRACE) {
        process.stderr.write(`[xdm] starting worker for ${sessionId} job=${JSON.stringify(job)}\n`);
      }
      // Throws when the job records no usable permission mode. That is the
      // intended failure: a worker started from the global setting is a
      // background job that quietly got more permission than the user gave it.
      const host = createWorkerHost({
        sessionId,
        job: job as WorkerHostJob,
        ...(options.command ? { command: options.command } : {}),
        ...(options.entryArgs ? { entryArgs: options.entryArgs } : {}),
        // The session's own workspace, or the directory it was created in. The
        // runtime refuses to load a session whose workspace does not match, and
        // a worker that cannot load its session can never answer.
        ...(typeof job.cwd === 'string' && job.cwd ? { cwd: job.cwd } : {}),
        version: options.version,
        onTurnSettled: (info) => {
          // Written to the durable timeline, so a reply survives the worker that
          // produced it and the peek surface can still show what was said.
          void options.jobs
            .appendTimeline(sessionId, {
              at: (options.now ?? Date.now)(),
              state: info.ok ? 'idle' : 'failed',
              detail: info.ok ? 'turn-finished' : 'turn-failed',
              turnId: info.turnId,
              text: info.error ?? info.reply,
            })
            .catch(() => undefined);
        },
        onProcessGone: (info) => {
          // Dropped from both maps: an entry that outlives its process makes
          // `job.send` deliver into a dead host instead of starting a new one,
          // and makes `daemon status` report a worker that cannot answer.
          hosts.delete(sessionId);
          workers.delete(sessionId);
          void options.jobs
            .appendTimeline(sessionId, {
              at: (options.now ?? Date.now)(),
              state: 'failed',
              detail: 'worker-exited',
              text: `code ${info.code ?? 'null'} signal ${info.signal ?? 'none'}`,
            })
            .catch(() => undefined);
        },
        ...(options.now ? { now: options.now } : {}),
      });
      const worker = adaptHost(sessionId, host);
      hosts.set(sessionId, { host, worker });
      workers.set(sessionId, worker);
      if (process.env.MCODE_WORKER_TRACE) {
        process.stderr.write(`[xdm] host created for ${sessionId}\n`);
      }
      const continuation = await host.startWithContinuation();
      await options.jobs.appendTimeline(sessionId, {
        at: (options.now ?? Date.now)(),
        state: continuation.continued ? 'working' : 'idle',
        detail: continuation.continued ? 'worker-continued' : 'worker-started',
      });
      if (continuation.continued) {
        await replayPending(sessionId, worker);
      }
    })();

    ready.set(sessionId, attempt.then(() => undefined));
    try {
      await attempt;
      return true;
    } catch (error) {
      // A job that cannot start a worker still keeps its row: the user needs to
      // see which session failed and why, and its staged messages must survive.
      await options.jobs.appendTimeline(sessionId, {
        at: (options.now ?? Date.now)(),
        state: 'failed',
        detail: 'worker-start-failed',
        text: error instanceof Error ? error.message : String(error),
      });
      hosts.delete(sessionId);
      workers.delete(sessionId);
      throw error;
    } finally {
      ready.delete(sessionId);
    }
  }

  async function replayPending(sessionId: string, worker: WorkerHostLike): Promise<void> {
    const staged = await options.jobs.listPending(sessionId);
    if (staged.length === 0) return;
    await options.jobs.appendTimeline(sessionId, {
      at: (options.now ?? Date.now)(),
      // `working`, not a new state: the session is busy replaying, and the agent
      // view only knows the six JobState values.
      state: 'working',
      detail: `pending-replay:${staged.length}`,
    });
    // Filenames are time-ordered by the store, so this is replay order and not
    // an arbitrary order: a user who sent two messages gets them in that order.
    for (const message of staged) {
      try {
        await worker.send({ sessionId, text: message.text, mode: readMode(message) });
        await options.jobs.resolvePending(sessionId, message.id);
      } catch (error) {
        // Stays on disk. A later start retries it, which is the whole point of
        // staging: a worker that is not ready yet must not cost the user a
        // message they already saw acknowledged as staged.
        await options.jobs.appendTimeline(sessionId, {
          at: (options.now ?? Date.now)(),
          state: 'idle',
          detail: 'pending-replay-retained',
          text: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  }

  function adaptHost(sessionId: string, host: ReturnType<typeof createWorkerHost>): WorkerHostLike {
    // Every `WorkerHostLike` method takes `{ sessionId }`, and this host is bound
    // to one session, so the adapter supplies it and ignores a mismatched id
    // rather than delivering another session's message into this one.
    function bound(input: { sessionId?: string } | undefined): string {
      return input?.sessionId ?? sessionId;
    }
    return {
      async send(input) {
        if (bound(input) !== sessionId) {
          throw new Error(`Worker for ${sessionId} cannot send to ${bound(input)}.`);
        }
        return host.send({ text: input.text, mode: input.mode });
      },
      stop: () => host.stop(),
      close: () => host.stop(),
      isAlive: () => host.state().workersAlive === 1,
      isBusy: () => host.state().promptInFlight,
      peek: (input) => host.peek({ after: input.after }),
      reply: (input) => host.reply({ interactionId: input.interactionId, outcome: input.outcome }),
      start: async () => true,
    };
  }
}

  function readMode(message: PendingMessage): 'queue' | 'steer' {
    return message.mode === 'steer' ? 'steer' : 'queue';
  }
