import type { TuiActiveRunSnapshot } from '../../../runtime/port.js';

/** A Tool call that has not returned yet is the case that needs a wait. */
const DEFAULT_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface WaitForTurnSettledDeps {
  readonly sessionId: string;
  readonly getActiveRun: (sessionId: string) => Promise<TuiActiveRunSnapshot>;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface TurnSettlementResult {
  readonly sessionId: string;
  /**
   * Whether the Turn reached a terminal state before the deadline.
   *
   * `false` is not a failure to adopt. The caller proceeds and the timeline
   * records the hand-off, so the state stays visible and recoverable — it just
   * cannot be called clean.
   */
  readonly settled: boolean;
  readonly attempts: number;
}

/**
 * Waits for an aborted Turn to reach disk.
 *
 * The hand-off only works if the abort has landed. A daemon that adopts a
 * session mid-abort reads a transcript whose tail is still an in-flight tool
 * call, finds nothing to continue, and leaves a job that says it is working
 * while nothing runs.
 *
 * The timeout is deliberately generous and deliberately non-fatal. A Turn
 * blocked on a permission request may never settle on its own, and refusing to
 * hand off in that case strands the session in a process the user is trying to
 * leave. Giving up and saying so is recoverable; returning early is the silent
 * version of the bug above.
 *
 * A failed inspection is retried rather than fatal: the runtime is mid-teardown
 * during an abort, and one errored call is not evidence the Turn is stuck.
 *
 * See mydocs/supervisor-plan-v2.md §2.1, §2.1.1.
 */
export async function waitForTurnSettled(
  deps: WaitForTurnSettledDeps,
): Promise<TurnSettlementResult> {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      const snapshot = await deps.getActiveRun(deps.sessionId);
      // `decision-blocked` is a Turn parked on a question. It has not settled,
      // and treating it as terminal would adopt a session whose transcript is
      // still mid-turn.
      if (snapshot.state === 'terminal' || snapshot.state === 'idle') {
        return { sessionId: deps.sessionId, settled: true, attempts };
      }
    } catch {
      // Fall through to the timeout check below.
    }

    if (Date.now() >= deadline) {
      return { sessionId: deps.sessionId, settled: false, attempts };
    }
    await sleep(intervalMs);
  }
}
