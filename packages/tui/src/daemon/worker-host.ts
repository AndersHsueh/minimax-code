import { EventEmitter } from 'node:events';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

import { createRecoveryPolicy, type RecoveryOutcome } from './recovery.js';
import { resolveWorkerLaunch, type WorkerLaunchPlan } from './launch-policy.js';
import { closeWorkerGracefully, type GracefulShutdownResult } from './shutdown.js';
import {
  isWorkerReclaimable,
  type JobState,
  type WorkerActivity,
  type WorkerObservation,
} from './worker-state.js';

export interface WorkerHostJob {
  readonly launch?: {
    readonly permissionMode?: string;
    readonly model?: string;
    readonly effort?: string;
    readonly lane?: string;
  };
  readonly lane?: string;
  /**
   * What the hand-off asked for. `continue: true` means the foreground released
   * a session with a Turn in flight, so the worker has to resume that Turn
   * rather than treat the session as freshly idle.
   */
  readonly handoff?: {
    readonly continue?: boolean;
  };
}

export interface SpawnedWorker {
  stdin: { write(chunk: string): void; end(): void };
  /**
   * The worker's stdout, when it is a real child process.
   *
   * Required in practice and the reason this interface is not just
   * `ChildProcess`: Node emits piped stdout data on the *stream*, never on the
   * process object. A host that listens on the process for `'data'` compiles,
   * passes its fakes, and then reads nothing from a real worker — which looks
   * exactly like a worker that accepted a request and never answered.
   */
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  kill(signal?: string): boolean;
  /**
   * Only for injected fakes that emit `'data'` on the process itself. A real
   * child never does, which is why `stdout` is the primary path.
   */
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface WorkerHostOptions {
  readonly sessionId: string;
  readonly job: WorkerHostJob;
  readonly spawn?: (options: {
    args: string[];
    detached: boolean;
    stdio: ['pipe', 'pipe', 'pipe'];
  }) => SpawnedWorker;
  /**
   * The executable to spawn. Defaults to the bare name `mcode`.
   *
   * When this is an interpreter, `entryArgs` names the script to run.
   */
  readonly command?: string;
  readonly entryArgs?: readonly string[];
  /**
   * Called when a Turn settles.
   *
   * The in-memory event tail dies with the process, so a reply the user already
   * waited for would vanish from the surface the moment the worker exits. This
   * is how the outcome gets written somewhere that outlives it.
   */
  readonly onTurnSettled?: (info: {
    readonly turnId: string;
    readonly ok: boolean;
    readonly reply: string;
    readonly error?: string;
  }) => void;
  /**
   * Called when the worker process is gone for good.
   *
   * The owner has to drop its entry here: a registry that still lists a dead
   * process reports a worker that cannot answer, and the next `send` is routed
   * into the void instead of starting a fresh one.
   */
  readonly onProcessGone?: (info: { readonly code: number | null; readonly signal: string | null }) => void;
  /**
   * The session's working directory, handed to `session/load`.
   *
   * The runtime refuses to load a session whose recorded workspace does not
   * match, so this has to be the directory the session was created in rather
   * than whatever the daemon happens to be sitting in.
   */
  readonly cwd?: string;
  /** Reported to the worker as the client's version during the handshake. */
  readonly version?: string;
  readonly now?: () => number;
  readonly idleTimeoutMs?: number;
}

export interface WorkerHostState {
  readonly sessionId: string;
  readonly status: 'stopped' | 'starting' | 'running' | 'failed';
  readonly state: JobState;
  readonly promptInFlight: boolean;
  readonly pendingInteractions: number;
  readonly reclaimable: boolean;
  readonly crashes: number;
  readonly workersAlive: number;
  readonly lastShutdown?: GracefulShutdownResult;
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;

/**
 * Owns one background worker: a `mcode acp` child and the ACP conversation with
 * it.
 *
 * The host is where the safety rules of §2.2, §2.3 and §3.9 become behaviour
 * rather than intent — each of them is a decision this class is the only place
 * that can make, because it is the only thing holding both the process and the
 * conversation with it.
 */
export function createWorkerHost(options: WorkerHostOptions) {
  const now = options.now ?? Date.now;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const launch: WorkerLaunchPlan = resolveWorkerLaunch({
    job: options.job,
    // Present only so a reader can see it is deliberately unused: the global
    // permission mode is exactly what a respawn must not pick up.
    globalPermissionMode: undefined,
  });
  const recovery = createRecoveryPolicy({ now });
  const spawnPlan = buildLaunchPlan(launch, options);
  const doSpawn = options.spawn ?? defaultSpawn;

  let child: SpawnedWorker | undefined;
  let nextId = 1;
  let promptTurnId: string | undefined;
  let requestedStop = false;
  let crashes = 0;
  let failureDetail: string | undefined;
  let lastActivity: WorkerActivity | undefined;
  let lastShutdown: GracefulShutdownResult | undefined;
  /** The worker's most recent stderr, so a failure can say why. */
  let lastStderr = '';
  /** Text of the reply being assembled from `session/update` chunks. */
  let replyBuffer = '';
  let idleSince = now();
  let lastInteractionAt: number | undefined;
  const interactions = new Set<string>();
  const watchers = new Set<string>();
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  /** Agent→client requests waiting for a response, keyed by JSON-RPC id. */
  const incoming = new Map<number, { method: string; params: unknown }>();
  /** The event tail `peek` serves. Bounded so a long-lived worker cannot grow without limit. */
  const events: Array<{ at: number; kind: string; turnId?: string; text?: string; id?: number }> = [];

  function request(method: string, params?: unknown): Promise<unknown> {
    const active = child;
    if (!active) return Promise.reject(new Error('Worker is not running.'));
    const id = nextId++;
    trace('>>', method, params);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      active.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }

  /**
   * Protocol trace, off unless `MCODE_WORKER_TRACE` is set.
   *
   * This is the only way to tell "the worker never got the prompt" from "the
   * worker got it and the model is still thinking" — both look identical from
   * the outside, and guessing between them wastes a whole debugging cycle.
   */
  function trace(direction: '>>' | '<<' | '!!', method: string, value?: unknown): void {
    if (!process.env.MCODE_WORKER_TRACE) return;
    let body = '';
    try {
      body = JSON.stringify(value)?.slice(0, 300) ?? String(value);
    } catch {
      body = '<unserializable>';
    }
    process.stderr.write(`[xdm] ${options.sessionId} ${direction} ${method} ${body}\n`);
  }

  function attach(next: SpawnedWorker): void {
    child = next;
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          if (process.env.MCODE_WORKER_TRACE) {
            process.stderr.write(`[xdm] ${options.sessionId} raw: ${line.slice(0, 200)}\n`);
          }
          consume(line);
        }
        newline = buffer.indexOf('\n');
      }
    };
    // stdout is the stream, not the process. Listening on the process is the
    // single reason this host could look healthy and still never see a reply.
    (next.stdout ?? next).on('data', onData);
    next.on('exit', (code, signal) => {
      child = undefined;
      if (process.env.MCODE_WORKER_TRACE) {
        process.stderr.write(`[xdm] worker exit code=${code} signal=${signal} stderr=${lastStderr}\n`);
      }
      // Every in-flight request dies with the process. Leaving them pending
      // would make each caller — `send`, `peek`, the activity probe — wait
      // forever for a reply that can never arrive, and one dead worker would
      // hang the daemon's whole request loop rather than just its own session.
      const error = new Error(`Worker exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}).`);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
      const outcome = recovery.onExit({
        code,
        signal,
        promptInFlight: promptTurnId !== undefined,
        requested: requestedStop,
      });
      crashes += 1;
      handleExit(outcome, { code, signal });
    });
    // stderr is piped, so it must be drained. An undrained pipe fills and blocks
    // the child, and a worker that dies with its reason still in the pipe looks
    // identical to one that hung.
    next.stderr?.on('data', (chunk) => {
      lastStderr = `${lastStderr}${chunk.toString('utf8')}`.slice(-4_000);
      if (process.env.MCODE_WORKER_TRACE) {
        process.stderr.write(`[xdm] ${options.sessionId} stderr: ${chunk.toString('utf8').slice(0, 300)}\n`);
      }
    });
    next.on('error', (error) => {
      lastStderr = `${lastStderr}${error.message}`.slice(-4_000);
    });
  }

  let buffer = '';

  function consume(line: string): void {
    let frame: {
      id?: unknown;
      result?: unknown;
      method?: string;
      params?: unknown;
      error?: { code?: unknown; message?: unknown };
    };

    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame.id === 'number' && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      const body = frame as { result?: unknown; error?: { code?: unknown; message?: unknown } };
      trace('<<', `id=${frame.id}`, body.error ?? body.result);
      // A JSON-RPC error is a failure, not an undefined result. Resolving it as
      // success is how a refused `session/load` turns into a prompt sent to a
      // session that was never loaded: every later step looks fine and nothing
      // ever runs.
      if (body.error) {
        entry?.reject(
          new Error(typeof body.error.message === 'string' ? body.error.message : 'Worker request failed.'),
        );
        return;
      }
      entry?.resolve(frame.result);
      return;
    }
    // A request *from* the agent: `session/request_permission` and
    // `elicitation/create` both wait for a JSON-RPC response on this same id, so
    // the id has to be kept to answer it. Answering wrong here is a permission
    // that never resolves, which looks to the user like the worker hung.
    if (typeof frame.method === 'string' && typeof frame.id === 'number') {
      if (frame.method === 'session/request_permission' || frame.method === 'elicitation/create') {
        incoming.set(frame.id, { method: frame.method, params: frame.params });
        lastInteractionAt = now();
        events.push({ at: now(), kind: 'interaction-requested', id: frame.id });
      }
      return;
    }
    if (typeof frame.method === 'string') consumeNotification(frame.method, frame.params);
  }

  function consumeNotification(method: string, params: unknown): void {
    if (method === 'session/request_permission' || method === 'elicitation/create') {
      const id = readInteractionId(params);
      if (id) interactions.add(id);
      return;
    }
    if (method === 'session/update') {
      idleSince = now();
      // The reply arrives here, not in the prompt's result. A worker that
      // reports "delivered" without ever keeping the text is indistinguishable
      // from one that delivered to a void.
      if (isAgentMessageChunk(params)) {
        replyBuffer += textOfChunk(params);
        if (replyBuffer.length > 8_000) replyBuffer = replyBuffer.slice(-8_000);
      }
    }
  }

  function handleExit(
    outcome: RecoveryOutcome,
    exit: { readonly code: number | null; readonly signal: string | null } = {
      code: null,
      signal: null,
    },
  ): void {
    promptTurnId = undefined;
    if (outcome.action === 'restart') {
      failureDetail = undefined;
      attach(doSpawn(spawnPlan));
      // The transcript is durable, so the interrupted Turn is picked up rather
      // than reissued from the top.
      void request('mcode/session/continue', { sessionId: options.sessionId }).catch(() => undefined);
      return;
    }
    if (outcome.action === 'fail') {
      // The worker's own stderr is the only place a real reason appears — a bad
      // model, a revoked key. Without it `failed` is a shrug the user cannot act on.
      failureDetail = [outcome.detail, lastStderr.trim()].filter(Boolean).join(': ');
    }
    // Reached only for a terminal outcome: the `restart` branch above already
    // returned, and a crash that will be restarted still has a live process
    // behind it, so dropping the entry then would lose the worker the recovery
    // is about to create.
    options.onProcessGone?.(exit);
  }

  /**
   * Brings the worker to a state where a prompt can actually run: the ACP
   * handshake first, then the session.
   *
   * Both steps are preconditions, not politeness. Without the handshake the
   * agent's capabilities are unknown to the client, and without the load the
   * session id resolves to nothing and `session/prompt` is refused.
   */
  let loaded: Promise<unknown> | undefined;

  function ensureLoaded(): Promise<unknown> {
    loaded ??= request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'minimax-code-daemon', version: options.version ?? '0.0.0' },
    }).then(() =>
      request('session/load', {
        sessionId: options.sessionId,
        cwd: options.cwd ?? process.cwd(),
        mcpServers: [],
      }),
    );
    return loaded;
  }

  async function probeActivity(): Promise<WorkerActivity | undefined> {
    try {
      const result = (await request('mcode/worker/activity', { sessionId: options.sessionId })) as
        | WorkerActivity
        | undefined;
      lastActivity = result;
      return result;
    } catch {
      return undefined;
    }
  }

  function observation(): WorkerObservation | undefined {
    if (!child) return undefined;
    if (!lastActivity) return undefined;
    return {
      workerAlive: true,
      promptInFlight: promptTurnId !== undefined,
      pendingInteractions: interactions.size,
      watchedByClients: watchers.size,
      activity: lastActivity,
    };
  }

  return {
    start(): void {
      requestedStop = false;
      if (process.env.MCODE_WORKER_TRACE) {
        process.stderr.write(`[xdm] spawn ${JSON.stringify(spawnPlan.args)}\n`);
      }
      attach(doSpawn(spawnPlan));
      idleSince = now();
    },

    /**
     * Starts the worker and, when the job records an interrupted Turn, resumes
     * it.
     *
     * This is the normal hand-off path, and it is separate from the crash
     * restart in {@link handleExit} on purpose. A host that only continues after
     * a crash looks correct and silently fails the feature: a session
     * backgrounded mid-Turn gets a live worker that reports itself idle, the row
     * says it is working, and nothing ever runs. That is the exact bug this
     * design exists to remove.
     *
     * A refusal is reported, not thrown and not swallowed: the worker's
     * continuation inspect answers with the reason, and a job that reports
     * success while its transcript had nothing to resume is lying to the user.
     */
    async startWithContinuation(): Promise<{ readonly continued: boolean }> {
      this.start();
      if (!options.job.handoff?.continue) return { continued: false };
      try {
        const result = (await request('mcode/session/continue', {
          sessionId: options.sessionId,
        })) as { continued?: boolean } | undefined;
        return { continued: result?.continued === true };
      } catch {
        return { continued: false };
      }
    },

    /**
     * Delivers one message to this session (§5.6.3).
     *
     * The branch depends on whether a Turn is in flight, and the idle case
     * deliberately uses `session/prompt` rather than the queue. `enqueue` goes
     * through `turn.submit({allowQueue: true})` and requires a `queued` result,
     * and whether an idle queue entry is pulled immediately is unverified — so
     * an idle worker gets a real prompt, which is known to start a Turn.
     *
     * A running tool is never interrupted: `steer` is admitted only against the
     * Turn that is actually active, and `queue` waits for the current Turn to
     * finish. Neither cancels anything.
     */
    async send(input: { text: string; mode: 'queue' | 'steer' }): Promise<unknown> {
      if (!child) throw new Error('Worker is not running.');
      if (input.mode === 'steer') {
        if (promptTurnId === undefined) {
          throw new Error('Steering needs an active Turn; the session is idle.');
        }
        const result = (await request('mcode/session/steer', {
          sessionId: options.sessionId,
          text: input.text,
        })) as { turnId?: string; mode?: string } | undefined;
        if (result?.mode !== 'steered') {
          throw new Error(`The worker did not steer the running Turn (${result?.mode ?? 'unknown'}).`);
        }
        events.push({ at: now(), kind: 'steered' });
        return result;
      }
      if (promptTurnId !== undefined) {
        // A Turn is running: the message has to wait for it, not race it.
        const queued = await request('mcode/session/queue/enqueue', {
          sessionId: options.sessionId,
          text: input.text,
        });
        events.push({ at: now(), kind: 'queued' });
        return queued;
      }
      // The prompt is long-running, so it is not awaited here: the caller needs
      // an answer about *delivery*, and a Turn's stop reason arrives much later.
      const turnId = `turn-${nextId++}`;
      promptTurnId = turnId;
      replyBuffer = '';
      idleSince = now();
      // A fresh `mcode acp` has no session in memory: `session/prompt` against
      // an unloaded id answers `Resource not found` and no Turn ever runs. The
      // load is what makes the id resolvable, and it replays history so the
      // worker answers as the same session rather than a blank one.
      void ensureLoaded()
        .then(() =>
          request('session/prompt', {
            sessionId: options.sessionId,
            prompt: [{ type: 'text', text: input.text }],
          }),
        )
        .then((result) => {
          const stopReason =
            (result as { stopReason?: string } | undefined)?.stopReason ?? 'end_turn';
          events.push({ at: now(), kind: 'turn-finished', turnId, text: replyBuffer });
          options.onTurnSettled?.({ turnId, ok: stopReason !== 'cancelled', reply: replyBuffer });
          promptTurnId = undefined;
          idleSince = now();
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          events.push({ at: now(), kind: 'turn-failed', turnId, text: reason });
          options.onTurnSettled?.({ turnId, ok: false, reply: replyBuffer, error: reason });
          promptTurnId = undefined;
          idleSince = now();
        });
      return { delivered: true, mode: 'prompt', turnId };
    },

    /**
     * Answers one pending permission or elicitation request.
     *
     * These arrive as agent→client JSON-RPC *requests* (see `consume`), so the
     * answer is a response on the same id, not a new request. An unknown id is
     * reported rather than guessed at: responding to a stale id would approve a
     * permission the user is no longer looking at.
     */
    async reply(input: { interactionId: string; outcome: string }): Promise<unknown> {
      const key = Number(input.interactionId);
      const waiting = Number.isFinite(key) ? incoming.get(key) : undefined;
      if (!waiting) return { rejected: 'unknown-interaction' as const };
      const optionId = input.outcome === 'allow' ? 'allow-once' : 'deny';
      const result =
        waiting.method === 'session/request_permission'
          ? { outcome: { outcome: 'selected', optionId } }
          : { action: input.outcome === 'allow' ? 'accept' : 'decline' };
      const active = child;
      if (!active) return { rejected: 'worker-gone' as const };
      // A response, not a request: the agent is blocked on this id.
      active.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: key, result })}\n`);
      incoming.delete(key);
      events.push({ at: now(), kind: 'interaction-resolved', id: key });
      return { replied: true, outcome: optionId };
    },

    /**
     * The event tail, oldest first.
     *
     * `after` is a cursor rather than an index, so a repainting surface does not
     * re-read a timeline that grows without bound. It is optional because a
     * caller asking "what has happened" has no cursor yet.
     */
    async peek(input: { after?: number } = {}): Promise<readonly unknown[]> {
      const after = input?.after;
      return events.filter((event) => after === undefined || event.at > after);
    },

    stop(): Promise<GracefulShutdownResult> {
      requestedStop = true;
      const active = child;
      if (!active) {
        return Promise.resolve({
          cancelled: false,
          timedOut: false,
          queueConfirmedPaused: true,
          pendingItems: 0,
        });
      }
      return closeWorkerGracefully({
        worker: {
          cancel: async () => (await request('session/cancel')) as { stopReason?: string },
          activity: async () =>
            (await probeActivity()) as unknown as {
              queuePaused: boolean;
              queuePending: number;
            },
          close: () => active.stdin.end(),
        },
        cancelTimeoutMs: 3_000,
      }).then((result) => {
        lastShutdown = result;
        return result;
      });
    },

    /**
     * One supervisor tick: refresh activity, then reclaim if nothing is running.
     *
     * Restarts are *not* handled here — the exit handler owns them. Doing it in
     * both places means a crash schedules two workers.
     */
    async tick(): Promise<void> {
      if (!child) return;
      await probeActivity();
      const view = observation();
      if (!view) return;
      if (!isWorkerReclaimable(view)) {
        idleSince = now();
        return;
      }
      if (now() - idleSince < idleTimeoutMs) return;
      await this.stop();
    },

    notePromptStarted(turnId: string): void {
      promptTurnId = turnId;
      idleSince = now();
    },

    notePromptFinished(): void {
      promptTurnId = undefined;
      idleSince = now();
    },

    noteInteraction(id: string): void {
      interactions.add(id);
    },

    resolveInteraction(id: string): void {
      interactions.delete(id);
    },

    noteWatcher(id = 'client'): void {
      watchers.add(id);
    },

    releaseWatcher(id = 'client'): void {
      watchers.delete(id);
    },

    state(): WorkerHostState {
      const status: WorkerHostState['status'] = failureDetail
        ? 'failed'
        : child
          ? 'running'
          : requestedStop || crashes > 0
            ? 'stopped'
            : 'starting';
      // The daemon knows about prompts and interactions from the conversation
      // itself, so the row state must not wait on an activity probe. Otherwise a
      // job that just raised a permission request renders as idle.
      const local = deriveLocal(
        {
          workerAlive: Boolean(child),
          promptInFlight: promptTurnId !== undefined,
          pendingInteractions: interactions.size,
          watchedByClients: watchers.size,
          activity: lastActivity ?? UNKNOWN_ACTIVITY,
        },
        failureDetail ? 'failed' : 'idle',
      );
      const view = observation();
      return {
        sessionId: options.sessionId,
        status,
        state: failureDetail ? 'failed' : local,
        promptInFlight: promptTurnId !== undefined,
        pendingInteractions: interactions.size,
        reclaimable: view ? isWorkerReclaimable(view) : false,
        crashes,
        workersAlive: child ? 1 : 0,
        ...(lastShutdown ? { lastShutdown } : {}),
      };
    },

    get failureDetail(): string | undefined {
      return failureDetail;
    },
  };
}

export type WorkerHost = ReturnType<typeof createWorkerHost>;

/** Before the first probe, assume nothing is running rather than everything. */
const UNKNOWN_ACTIVITY: WorkerActivity = {
  runState: 'idle',
  queuePending: 0,
  queuePaused: false,
  goalActive: false,
  backgroundTasks: 0,
};

/** Pulls the request id out of an ACP request notification, tolerating nesting. */
function readInteractionId(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const record = params as Record<string, unknown>;
  for (const key of ['interactionId', 'requestId', 'id']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  const request = record.request;
  if (request && typeof request === 'object') {
    const inner = request as Record<string, unknown>;
    for (const key of ['interactionId', 'requestId', 'id']) {
      const value = inner[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return undefined;
}

/** True when a `session/update` carries assistant text, which is the reply. */
function isAgentMessageChunk(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false;
  const update = (params as { update?: { sessionUpdate?: unknown } }).update;
  return update?.sessionUpdate === 'agent_message_chunk';
}

function textOfChunk(params: unknown): string {
  const content = (params as { update?: { content?: { text?: unknown } } }).update?.content;
  return typeof content?.text === 'string' ? content.text : '';
}

function deriveLocal(view: WorkerObservation, recorded: JobState): JobState {
  if (view.pendingInteractions > 0) return 'needs-input';
  if (view.promptInFlight) return 'working';
  return recorded;
}

interface SpawnPlan {
  readonly args: string[];
  readonly detached: true;
  /**
   * stdin is a pipe, not `'ignore'`.
   *
   * `mcode acp` is a stdio server: it reads JSON-RPC from stdin until EOF, so an
   * ignored stdin closes immediately and the worker exits 0 before it has
   * answered anything. A worker that never got a chance to run looks exactly
   * like one that started and died.
   */
  readonly stdio: ['pipe', 'pipe', 'pipe'];
}

function buildLaunchPlan(launch: WorkerLaunchPlan, options: WorkerHostOptions): SpawnPlan {
  return {
    args: [
      options.command ?? 'mcode',
      // When the command is a bare interpreter, the script to run comes first.
      // Without this a `node /abs/cli.js` override would start a REPL instead of
      // the CLI, and the worker would look alive while never answering.
      ...(options.entryArgs ?? []),
      'acp',
      '--permission-mode',
      launch.permissionMode,
      ...(launch.model ? ['--model', launch.model] : []),
      ...(launch.effort ? ['--effort', launch.effort] : []),
      ...(launch.lane ? ['--lane', launch.lane] : []),
    ],
    // Detached so closing the terminal that launched the daemon does not
    // SIGHUP the workers it owns.
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };
}

function defaultSpawn(plan: SpawnPlan): SpawnedWorker {
  const [command, ...args] = plan.args;
  return spawn(command ?? 'mcode', args, {
    detached: plan.detached,
    stdio: plan.stdio,
  }) as unknown as SpawnedWorker;
}

export { EventEmitter };
