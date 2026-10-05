export interface BackgroundSessionDeps {
  readonly sessionId: string;
  /** Current composer text. Non-empty means the user has something unsent. */
  readonly getComposerText: () => string;
  /** The active Turn id, or undefined when the session is idle. */
  readonly getActiveTurnId: () => string | undefined;
  readonly abortSession: (input: { id: string; reason: string }) => Promise<boolean>;
  /** Resolves once the aborted Turn has reached a terminal state on disk. */
  readonly waitForTurnSettled: (sessionId: string) => Promise<void>;
  readonly getPermissionMode: () => Promise<string>;
  readonly adoptJob: (input: {
    sessionId: string;
    launch: { permissionMode: string };
    handoff: { continue: boolean };
  }) => Promise<
    { adopted: true } | { adopted: false; reason: 'no-daemon' | 'busy' | 'refused' }
  >;
  readonly appendTimeline: (
    sessionId: string,
    entry: { at: number; state: string; detail: string },
  ) => Promise<void>;
  readonly isDaemonOnline: () => boolean;
  readonly ensureDaemon: () => Promise<void>;
  readonly now?: () => number;
  readonly notify?: (message: string) => void;
}

export type BackgroundSessionResult =
  | { readonly status: 'adopted'; readonly continued: boolean }
  | {
      readonly status: 'refused';
      readonly reason:
        | 'composer-not-empty'
        | 'daemon-unavailable'
        | 'no-daemon'
        | 'busy'
        | 'refused';
    };

/**
 * Hands the current session off to the background supervisor.
 *
 * A Turn runs inside the foreground process and cannot be moved, so backgrounding
 * a live session means ending that Turn and letting a different process pick the
 * work up from the durable transcript. Every step in between can silently lose
 * work, which is why the order is fixed:
 *
 *  1. refuse if the composer has unsent text — discarding what someone just typed
 *     is worse than refusing
 *  2. make sure a supervisor exists, *before* touching the Turn
 *  3. an idle session is adopted as-is: there is nothing to end, and aborting
 *     "just in case" would pause the queue and the Goal, leaving a backgrounded
 *     job that never runs again
 *  4. a live session is ended with `background_handoff` — **not**
 *     `session_leave`, which pauses the queue durably, so every later message
 *     would sit in a paused queue while the row claimed to be running
 *  5. wait for the Turn to settle, then adopt
 *  6. bracket the adoption in the timeline, so a crash in between is visible
 *
 * See mydocs/supervisor-plan-v2.md §2.1 and §2.1.1.
 */
export async function backgroundSession(
  deps: BackgroundSessionDeps,
): Promise<BackgroundSessionResult> {
  const now = deps.now ?? Date.now;

  if (deps.getComposerText().trim()) {
    return refuse(deps, 'composer-not-empty', 'You have unsent text. Send or clear it first.');
  }

  // Checked before the abort on purpose. Discovering there is nowhere to resume
  // *after* ending the Turn loses the work outright.
  if (!deps.isDaemonOnline()) {
    await deps.ensureDaemon();
    if (!deps.isDaemonOnline()) {
      return refuse(
        deps,
        'daemon-unavailable',
        'The background supervisor is not running, so this session has nowhere to go.',
      );
    }
  }

  const liveTurnId = deps.getActiveTurnId();
  if (!liveTurnId) {
    return adopt(deps, { continue: false });
  }

  const stopped = await deps.abortSession({
    id: deps.sessionId,
    reason: 'background_handoff',
  });
  if (!stopped) {
    return refuse(deps, 'busy', 'This session could not be handed off right now.');
  }
  await deps.waitForTurnSettled(deps.sessionId);
  return adopt(deps, { continue: true });
}

async function adopt(
  deps: BackgroundSessionDeps,
  handoff: { continue: boolean },
): Promise<BackgroundSessionResult> {
  if (handoff.continue) {
    // Only a live Turn is worth bracketing. An idle hand-off has nothing to
    // reconcile, and a lone `handoff-begin` would read as a crash.
    await deps.appendTimeline(deps.sessionId, {
      at: (deps.now ?? Date.now)(),
      state: 'backgrounding',
      detail: 'handoff-begin',
    });
  }
  // Captured here, not read later: the mode a worker will start with has to be
  // the one in effect at hand-off, or the respawn-safety rule has no anchor.
  const permissionMode = await deps.getPermissionMode();
  const result = await deps.adoptJob({
    sessionId: deps.sessionId,
    launch: { permissionMode },
    handoff,
  });
  if (!result.adopted) {
    return refuse(
      deps,
      result.reason,
      result.reason === 'no-daemon'
        ? 'The background supervisor is not running, so this session has nowhere to go.'
        : 'This session could not be handed off right now.',
    );
  }
  if (handoff.continue) {
    await deps.appendTimeline(deps.sessionId, {
      at: (deps.now ?? Date.now)(),
      state: 'background',
      detail: 'handoff-committed',
    });
  }
  return { status: 'adopted', continued: handoff.continue };
}

function refuse(
  deps: BackgroundSessionDeps,
  reason: Extract<BackgroundSessionResult, { status: 'refused' }>['reason'],
  message: string,
): BackgroundSessionResult {
  deps.notify?.(message);
  return { status: 'refused', reason };
}
