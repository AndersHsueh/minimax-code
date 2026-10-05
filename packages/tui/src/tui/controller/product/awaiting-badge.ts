import { awaitingBadge, type AgentViewRow } from '../../features/agents/view-model.js';

export interface AwaitingPush {
  readonly count: number;
  readonly sessionIds: readonly string[];
}

export interface AwaitingBadgeBindingOptions {
  /** Whether the supervisor can currently be reached. */
  readonly reachable: () => boolean;
  readonly rows: () => readonly AgentViewRow[];
  /**
   * The one request a subscription may make: the initial full read.
   *
   * Everything after that comes from a push. A binding that re-asked on an
   * interval would be a poll wearing a subscription's name.
   */
  readonly load?: () => readonly AgentViewRow[];
  readonly onPush?: (push: AwaitingPush) => void;
}

export interface AwaitingBadgeBinding {
  /** Footer text, or undefined when the badge must not be shown. */
  label(): string | undefined;
  applyPush(push: AwaitingPush): void;
  markUnreachable(): void;
  pendingSessionIds(): readonly string[];
  start(): void;
  stop(): void;
}

/**
 * The footer's `← N awaiting`, fed by a daemon subscription.
 *
 * The badge is a promise that a human is needed, not a job counter. That is why
 * it counts only `needs-input` and why it disappears entirely when the
 * supervisor cannot be reached: a badge that could not ask must not answer
 * "nothing is waiting", because the moment that claim is dangerous is exactly
 * when a job is parked on a question nobody has seen.
 *
 * There is no timer anywhere in here. The daemon pushes on change, so a
 * permission request shows up while the user is doing something else — which is
 * the whole reason this is a subscription.
 */
export function createAwaitingBadgeBinding(
  options: AwaitingBadgeBindingOptions,
): AwaitingBadgeBinding {
  let pushedCount: number | undefined;
  let pushedIds: readonly string[] = [];
  // Until `start()` runs there is no subscription, so there is no basis for any
  // claim — not even "nothing is waiting". The badge is only ever as honest as
  // the evidence behind it, and no subscription means no evidence.
  let reachable = false;
  let started = false;
  let stopped = false;

  function label(): string | undefined {
    if (!started || !reachable) return undefined;
    if (pushedCount !== undefined) {
      return pushedCount > 0 ? `← ${String(pushedCount)} awaiting` : undefined;
    }
    const badge = awaitingBadge(options.rows(), true);
    return badge.visible ? `← ${String(badge.count)} awaiting` : undefined;
  }

  return {
    label,
    applyPush: (push) => {
      // A disposed subscription that still repaints is a leak with a repaint.
      if (stopped || !started) return;
      reachable = true;
      pushedCount = push.count;
      pushedIds = [...push.sessionIds];
      options.onPush?.(push);
    },
    markUnreachable: () => {
      // Drop the count rather than freeze it: a frozen count sends the user to
      // a job the supervisor can no longer act on.
      pushedCount = undefined;
      pushedIds = [];
      reachable = false;
    },
    pendingSessionIds: () => [...pushedIds],
    start: () => {
      if (started || stopped) return;
      started = true;
      reachable = options.reachable();
      options.load?.();
    },
    stop: () => {
      stopped = true;
      started = false;
    },
  };
}
