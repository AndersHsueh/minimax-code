export interface RecoveryOptions {
  readonly now?: () => number;
  /** Restarts allowed inside the window before a job is failed. */
  readonly maxRestarts?: number;
  readonly windowMs?: number;
}

export interface WorkerExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Whether a prompt was in flight when the process died. */
  readonly promptInFlight: boolean;
  /** Set when this exit was asked for, rather than suffered. */
  readonly requested?: boolean;
}

export type RecoveryOutcome =
  | { readonly action: 'none'; readonly reason: 'requested' | 'clean-exit' | 'idle-exit' }
  | { readonly action: 'restart'; readonly continueRun: true; readonly backoffMs: number }
  | { readonly action: 'fail'; readonly detail: string };

/** The first two backoff steps from the plan; a third crash gives up. */
const BACKOFF_STEPS_MS = [5_000, 30_000] as const;
const DEFAULT_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_RESTARTS = 2;

/**
 * Decides what a dead worker means.
 *
 * The distinction that matters is not exit code but whether a prompt was in
 * flight. A crash mid-prompt leaves a durable transcript that
 * `mcode/session/continue` can pick up. A crash while idle leaves nothing to
 * resume, and restarting would spin up a process for a job that had already
 * finished — which is also how a worker that cannot start (a revoked key, a
 * deleted model) turns into an invisible loop instead of a visible failure.
 */
export function createRecoveryPolicy(options: RecoveryOptions = {}) {
  const now = options.now ?? Date.now;
  const maxRestarts = options.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  let recent: number[] = [];

  return {
    onExit(exit: WorkerExit): RecoveryOutcome {
      const at = now();
      recent = recent.filter((stamp) => at - stamp < windowMs);

      if (exit.requested) {
        return { action: 'none', reason: 'requested' };
      }
      const cleanExit = exit.code === 0 && exit.signal === null;
      if (cleanExit) {
        return { action: 'none', reason: 'clean-exit' };
      }
      if (!exit.promptInFlight) {
        // Nothing was running, so there is nothing to continue. Marking it and
        // leaving it alone is the correct terminal state, not a failure to retry.
        return { action: 'none', reason: 'idle-exit' };
      }
      if (recent.length >= maxRestarts) {
        return {
          action: 'fail',
          detail: `Worker crashed ${recent.length + 1} times within ${Math.round(windowMs / 60_000)} minutes; last exit ${
            exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`
          }. Transcript and pending messages are kept.`,
        };
      }
      recent.push(at);
      return {
        action: 'restart',
        continueRun: true,
        backoffMs: BACKOFF_STEPS_MS[Math.min(recent.length - 1, BACKOFF_STEPS_MS.length - 1)],
      };
    },
  };
}
