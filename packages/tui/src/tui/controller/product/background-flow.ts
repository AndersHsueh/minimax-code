import {
  backgroundSession,
  type BackgroundSessionDeps,
  type BackgroundSessionResult,
} from '../../features/agents/handoff.js';

export interface TuiBackgroundSessionFlowOptions {
  /**
   * Composer feedback — the only way the user learns a refusal happened.
   *
   * The tone vocabulary is the Composer's own (`danger` / `warning`). A
   * success message deliberately passes no tone: it is information, not an
   * alarm, and reusing `warning` would make every successful hand-off look
   * like a problem.
   */
  readonly setHint?: (message: string, tone?: 'danger' | 'warning') => void;
  readonly onChanged?: () => void;
}

/**
 * The foreground TUI's half of a hand-off.
 *
 * It exists to own two things the pure flow cannot: telling the user what
 * happened, and refusing to start a second one. The second is not defensive
 * programming — two concurrent adopts race on the same `job.json`, and the
 * loser would report a hand-off that never happened, which is the exact
 * failure mode this whole feature exists to remove.
 *
 * It deliberately holds no runtime, no socket and no daemon handle. Everything
 * it needs arrives as {@link BackgroundSessionDeps}, so the ordering rules in
 * §2.1 stay testable without a process.
 *
 * See mydocs/supervisor-plan-v2.md §2.1, §2.1.1.
 */
export function createTuiBackgroundSessionFlow(
  deps: BackgroundSessionDeps,
  options: TuiBackgroundSessionFlowOptions = {},
) {
  let inFlight = false;

  async function background(): Promise<BackgroundSessionResult> {
    if (inFlight) {
      const message = 'This session is already being sent to the background.';
      options.setHint?.(message, 'warning');
      return { status: 'refused', reason: 'busy' };
    }
    inFlight = true;
    try {
      const result = await backgroundSession({
        ...deps,
        notify: (message) => {
          options.setHint?.(message, 'warning');
          options.onChanged?.();
        },
      });
      if (result.status === 'adopted') {
        // No tone: this is information, not a warning.
        options.setHint?.(
          result.continued
            ? 'This session is running in the background. Press ← on an empty Composer to come back.'
            : 'This session is in the background. Press ← on an empty Composer to come back.',
        );
      }
      options.onChanged?.();
      return result;
    } finally {
      inFlight = false;
    }
  }

  return {
    background,
    /** In flight, so the view can disable the affordance that triggers it. */
    isBackgrounding: () => inFlight,
    sessionId: () => deps.sessionId,
  };
}
