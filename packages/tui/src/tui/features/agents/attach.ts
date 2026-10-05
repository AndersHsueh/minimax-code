/**
 * Phase 4 contract: attach v1 is a transfer of the driving position, not a
 * window onto a worker.
 *
 * A backgrounded session is driven by a worker process. Attaching it means
 * becoming the thing that drives it. That is the entire scope of v1 — the plan
 * puts remote live rendering in Phase 5, and the reason it is not needed is
 * worth keeping: a foreground TUI rewrites a session's history into the
 * *current terminal's* scrollback, so taking over a session restores a view the
 * user can scroll. This is the point where the plan diverges from Claude Code,
 * whose constraint is that a new terminal has no history to restore.
 *
 * The two cases are not variants:
 *
 *  - **A, no live worker.** The TUI owns the session completely; every slash
 *    command, plan mode and Goal UI works, and no read-only mode is imposed.
 *  - **B, worker still running.** The TUI does *not* own it. It opens a live
 *    peek, Enter queues instead of submitting, and `Ctrl+C` stops the job.
 *    Taking ownership here puts two drivers on one transcript.
 *
 * A session already attached elsewhere is refused rather than stolen: both
 * holders would believe they own the queue, and the second to write a Turn is
 * the one whose work is lost.
 *
 * See mydocs/supervisor-plan-v2.md §3.7, §3.7.1.
 */

export interface AttachDeps {
  readonly sessionId: string;
  /** `job.attach.begin` — asks who owns the session and whether a worker is live. */
  readonly attach: (input: { sessionId: string }) => Promise<
    | { readonly owner: 'client'; readonly live: false }
    | { readonly owner: 'worker'; readonly live: true }
    | { readonly owner: 'none'; readonly live: false; readonly reason: 'already-attached' }
  >;  /**
   * Rebuilds the session from its durable history.
   *
   * The TUI has no in-memory state for a session it did not start. Skipping
   * this opens the composer on an empty transcript, and the user's next message
   * continues a conversation they cannot see.
   */
  readonly loadSessionProjection: (sessionId: string) => Promise<void>;
  /** `job.attach.commit` — tells the daemon the TUI now drives the session. */
  readonly attachCommit: (sessionId: string) => Promise<{ readonly attached: boolean }>;
  /** The durable tail, for the case-B live surface. */
  readonly peek: (input: {
    sessionId: string;
    after?: number;
  }) => Promise<{ readonly owner: string; readonly live: boolean; readonly events: readonly unknown[] }>;
  readonly onOpenAgentView?: () => void;
  readonly onNotify?: (message: string) => void;
}

export type AttachResult =
  | { readonly mode: 'owned'; readonly readOnly: false; readonly sessionId: string }
  | { readonly mode: 'peek'; readonly readOnly: true; readonly live: true; readonly sessionId: string }
  | { readonly mode: 'refused'; readonly reason: 'already-attached'; readonly sessionId: string }
  | { readonly mode: 'failed'; readonly sessionId: string };

export async function attachSession(deps: AttachDeps): Promise<AttachResult> {
  let claim: Awaited<ReturnType<AttachDeps['attach']>>;
  try {
    claim = await deps.attach({ sessionId: deps.sessionId });
  } catch {
    // Not an "owned" result on a failed attach: that would leave the user
    // typing into a session the daemon still believes a worker drives.
    deps.onNotify?.("Couldn't reach the background supervisor. Nothing was attached.");
    return { mode: 'failed', sessionId: deps.sessionId };
  }

  if (claim.owner === 'none') {
    deps.onNotify?.('That session is already attached in another window.');
    return { mode: 'refused', reason: 'already-attached', sessionId: deps.sessionId };
  }

  if (claim.owner === 'worker' && claim.live) {
    // Case B. The worker keeps the session; this is a read-only window onto it.
    deps.onNotify?.(
      'That session is still running in the background. You can watch it and queue messages; the next turn starts automatically when it finishes.',
    );
    return { mode: 'peek', readOnly: true, live: true, sessionId: deps.sessionId };
  }

  // Case A. Load before committing: committing first opens a window where the
  // daemon believes the TUI owns a session whose history is not loaded yet, and
  // a message sent into that window lands with no visible context.
  try {
    await deps.loadSessionProjection(deps.sessionId);
  } catch {
    deps.onNotify?.("Couldn't load that session's history. Nothing was attached.");
    return { mode: 'failed', sessionId: deps.sessionId };
  }
  try {
    await deps.attachCommit(deps.sessionId);
  } catch {
    deps.onNotify?.("Couldn't take ownership of that session. Nothing was attached.");
    return { mode: 'failed', sessionId: deps.sessionId };
  }
  deps.onOpenAgentView?.();
  return { mode: 'owned', readOnly: false, sessionId: deps.sessionId };
}
