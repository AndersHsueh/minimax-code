/** The slice of an ACP worker this shutdown path needs. */
export interface GracefulShutdownWorker {
  /** `session/cancel`. Leaves the prompt settled and pauses the queue. */
  cancel(signal?: AbortSignal): Promise<{ readonly stopReason?: string }>;
  /** `mcode/worker/activity`, for confirming the queue reached `paused`. */
  activity(): Promise<{ readonly queuePaused: boolean; readonly queuePending: number }>;
  close(): void | Promise<void>;
}

export interface GracefulShutdownOptions {
  readonly worker: GracefulShutdownWorker;
  readonly cancelTimeoutMs?: number;
  readonly queueConfirmTimeoutMs?: number;
}

export interface GracefulShutdownResult {
  readonly cancelled: boolean;
  readonly timedOut: boolean;
  /**
   * False means queued items may still be `queued` and will re-fire the next
   * time this session is started. The caller has to say so out loud rather than
   * report a clean stop.
   */
  readonly queueConfirmedPaused: boolean;
  readonly pendingItems: number;
}

/**
 * Stops a worker in the only order that is safe.
 *
 * Phase 0' measured the alternatives. `session/cancel` settles the prompt in
 * ~59ms and writes a `user-stop` row, which leaves queued items `paused`.
 * Closing stdin or sending SIGTERM leaves the prompt unsettled after 45s, writes
 * no pause row, and leaves those items `queued` — and a `queued` item executes
 * automatically the next time the session is started. For a background job that
 * means work continuing in a process the user believes is gone.
 *
 * So the sequence is: cancel, wait for the settle, confirm the queue, and only
 * then close. The timeouts exist because a hung prompt must not wedge the
 * daemon; they degrade the *report*, never the ordering.
 */
export async function closeWorkerGracefully(
  options: GracefulShutdownOptions,
): Promise<GracefulShutdownResult> {
  const cancelTimeoutMs = options.cancelTimeoutMs ?? 3_000;
  const queueConfirmTimeoutMs = options.queueConfirmTimeoutMs ?? 1_000;

  const cancelled = await withTimeout(
    options.worker.cancel().then(() => true),
    cancelTimeoutMs,
    false,
  );
  const activity = await withTimeout(
    options.worker.activity().catch(() => undefined),
    queueConfirmTimeoutMs,
    undefined,
  );
  // Closed last, unconditionally. The window where the worker can still accept
  // work is exactly the window where its queue is guaranteed paused.
  await options.worker.close();
  return {
    cancelled,
    timedOut: !cancelled,
    queueConfirmedPaused: activity?.queuePaused === true,
    pendingItems: activity?.queuePending ?? 0,
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
