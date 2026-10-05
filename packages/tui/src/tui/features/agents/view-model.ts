export type AgentViewState =
  | 'needs-input'
  | 'working'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface AgentViewRow {
  readonly sessionId: string;
  readonly name?: string;
  readonly state: AgentViewState;
  /** Whether the worker process is alive right now. */
  readonly workersAlive: number;
  readonly queuePaused?: boolean;
  readonly lane?: string;
  readonly summary?: string;
}

export type AgentRowMarker = 'busy-mark' | 'idle-mark' | 'error-mark';

export interface AgentViewEntry extends AgentViewRow {
  readonly marker: AgentRowMarker;
  readonly flags: readonly string[];
}

export interface AgentViewGroup {
  readonly state: AgentViewState;
  readonly rows: readonly AgentViewEntry[];
}

export interface AgentView {
  readonly groups: readonly AgentViewGroup[];
  readonly rows: readonly AgentViewEntry[];
  readonly counts: Readonly<Record<AgentViewState | 'total', number>>;
}

/** Attention first, then work in progress, then everything at rest. */
const GROUP_ORDER: readonly AgentViewState[] = [
  'needs-input',
  'working',
  'idle',
  'completed',
  'failed',
  'stopped',
];

/**
 * The agent view's data layer.
 *
 * Two things it refuses to do:
 *
 *  - **conflate rest with failure.** Both would render as a dot, and a view that
 *    does that trains people to ignore the dot. `completed`/`stopped` are rest;
 *    only `failed` is an error, and only when the worker is not alive.
 *  - **infer liveness from the last recorded state.** The `✻` versus `∙`
 *    distinction is *process* liveness. A job whose last recorded state is
 *    `working` but whose worker is gone is at rest, and showing it as busy sends
 *    the user to wait for something that is not running.
 *
 * Group order and intra-group order are both deterministic, because the
 * selection follows rows: a row that jumps groups when an unrelated row changes
 * state moves the cursor to a different session.
 */
export function buildAgentView(rows: readonly AgentViewRow[]): AgentView {
  const entries = rows.map((row) => toEntry(row));

  const groups: AgentViewGroup[] = [];
  // Flat rows follow the rendered order — group by group — not a global sort, so
  // an index the view uses for the cursor always names the row under the cursor.
  // A view that sorted globally would put `needs-input` in the middle of the list
  // while rendering its group at the top.
  const ordered: AgentViewEntry[] = [];
  for (const state of GROUP_ORDER) {
    const inGroup = entries
      .filter((entry) => entry.state === state)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
    if (inGroup.length === 0) continue;
    groups.push({ state, rows: inGroup });
    ordered.push(...inGroup);
  }

  const counts = { total: ordered.length } as Record<AgentViewState | 'total', number>;
  for (const state of GROUP_ORDER) counts[state] = 0;
  for (const entry of ordered) counts[entry.state] += 1;

  return { groups, rows: ordered, counts };
}

function toEntry(row: AgentViewRow): AgentViewEntry {
  const alive = row.workersAlive > 0;
  const flags: string[] = [];
  // Reported, never acted on: a paused queue is the user's own earlier stop,
  // and backgrounding must not quietly undo it.
  if (row.queuePaused) flags.push('queue-paused');
  return {
    ...row,
    marker: markerFor(row, alive),
    flags,
  };
}

function markerFor(row: AgentViewRow, alive: boolean): AgentRowMarker {
  if (!alive) return row.state === 'failed' ? 'error-mark' : 'idle-mark';
  if (row.state === 'needs-input' || row.state === 'working') return 'busy-mark';
  return 'idle-mark';
}

export interface AwaitingBadge {
  readonly visible: boolean;
  readonly count: number;
}

/**
 * The footer's `← N awaiting`.
 *
 * It is a promise that something needs a human, not a job counter, so it counts
 * only rows waiting on an answer. And it disappears when the supervisor cannot
 * be reached: a badge that could not ask must not report "nothing is waiting",
 * because the one moment that claim is dangerous is exactly when a job is
 * parked on a question nobody has seen.
 */
export function awaitingBadge(
  rows: readonly AgentViewRow[],
  supervisorReachable: boolean,
): AwaitingBadge {
  if (!supervisorReachable) return { visible: false, count: 0 };
  const count = rows.filter((row) => row.state === 'needs-input').length;
  return { visible: count > 0, count };
}
