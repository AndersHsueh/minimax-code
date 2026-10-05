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
}

export interface SpawnedWorker {
  stdin: { write(chunk: string): void; end(): void };
  kill(signal?: string): boolean;
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
    stdio: ['ignore', 'pipe', 'pipe'];
  }) => SpawnedWorker;
  readonly command?: string;
  readonly execPath?: string;
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
  let idleSince = now();
  const interactions = new Set<string>();
  const watchers = new Set<string>();
  const pending = new Map<number, { resolve: (value: unknown) => void }>();

  function request(method: string, params?: unknown): Promise<unknown> {
    const active = child;
    if (!active) return Promise.reject(new Error('Worker is not running.'));
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      active.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`,
      );
    });
  }

  function attach(next: SpawnedWorker): void {
    child = next;
    next.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) consume(line);
        newline = buffer.indexOf('\n');
      }
    });
    next.on('exit', (code, signal) => {
      child = undefined;
      const outcome = recovery.onExit({
        code,
        signal,
        promptInFlight: promptTurnId !== undefined,
        requested: requestedStop,
      });
      crashes += 1;
      handleExit(outcome);
    });
    next.on('error', () => {
      // A spawn failure surfaces as an `error`; the exit path handles the rest.
    });
  }

  let buffer = '';

  function consume(line: string): void {
    let frame: { id?: unknown; result?: unknown; method?: string; params?: unknown };
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof frame.id === 'number' && pending.has(frame.id)) {
      const entry = pending.get(frame.id);
      pending.delete(frame.id);
      entry?.resolve(frame.result);
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
    }
  }

  function handleExit(outcome: RecoveryOutcome): void {
    promptTurnId = undefined;
    if (outcome.action === 'restart') {
      failureDetail = undefined;
      attach(doSpawn(spawnPlan));
      // The transcript is durable, so the interrupted Turn is picked up rather
      // than reissued from the top.
      void request('mcode/session/continue', { sessionId: options.sessionId }).catch(() => undefined);
      return;
    }
    if (outcome.action === 'fail') failureDetail = outcome.detail;
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
      attach(doSpawn(spawnPlan));
      idleSince = now();
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

function deriveLocal(view: WorkerObservation, recorded: JobState): JobState {
  if (view.pendingInteractions > 0) return 'needs-input';
  if (view.promptInFlight) return 'working';
  return recorded;
}

interface SpawnPlan {
  readonly args: string[];
  readonly detached: true;
  readonly stdio: ['ignore', 'pipe', 'pipe'];
}

function buildLaunchPlan(launch: WorkerLaunchPlan, options: WorkerHostOptions): SpawnPlan {
  return {
    args: [
      options.command ?? 'mcode',
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
    stdio: ['ignore', 'pipe', 'pipe'],
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
