import { describe, expect, it } from 'vitest';

import {
  buildAgentView,
  awaitingBadge,
  type AgentViewRow,
} from '../packages/tui/src/tui/features/agents/view-model.js';

/**
 * Phase 4 contract: what the agent view shows, and what the footer promises.
 *
 * Two rules here exist to stop the UI from lying.
 *
 * **`∙` is not an error.** A column of dots means the job finished or is
 * resting, which is the normal state for a background session. A view that
 * renders rest and failure identically trains people to ignore the failure.
 *
 * **The footer badge is a promise about a human, not a counter.** `← N awaiting`
 * exists so a user who backgrounded something knows it stopped and is waiting on
 * *them*. It therefore counts rows that are waiting for an answer, and it
 * disappears entirely when no supervisor is reachable — a badge that counts
 * nothing because it could not ask is worse than no badge.
 *
 * A paused queue is surfaced as a row marker rather than acted on: the pause is
 * the user's own earlier decision, and §2.4 is explicit that backgrounding must
 * not clear it.
 *
 * See mydocs/supervisor-plan-v2.md §2.4, §3.3, and the Phase 4 footer item.
 */
function row(overrides: Partial<AgentViewRow> = {}): AgentViewRow {
  return {
    sessionId: 'session-1',
    name: 'refactor',
    state: 'working',
    workersAlive: 1,
    queuePaused: false,
    ...overrides,
  };
}

describe('agent view model', () => {
  it('groups rows so the ones that need attention come first', () => {
    const view = buildAgentView([
      row({ sessionId: 'a', state: 'idle' }),
      row({ sessionId: 'b', state: 'needs-input' }),
      row({ sessionId: 'c', state: 'working' }),
    ]);

    expect(view.groups.map((group) => group.state)).toEqual([
      'needs-input',
      'working',
      'idle',
    ]);
  });

  it('omits groups with nothing in them', () => {
    // An empty "Failed (0)" heading is noise; the absence of the heading is the
    // signal.
    const view = buildAgentView([row({ state: 'working' })]);
    expect(view.groups.map((group) => group.state)).toEqual(['working']);
  });

  it('counts each state in the header', () => {
    const view = buildAgentView([
      row({ sessionId: 'a', state: 'working' }),
      row({ sessionId: 'b', state: 'working' }),
      row({ sessionId: 'c', state: 'needs-input' }),
    ]);

    expect(view.counts).toMatchObject({ total: 3, working: 2, 'needs-input': 1 });
  });

  it('keeps rest distinguishable from failure', () => {
    // The two look identical if you only glance at a glyph.
    const view = buildAgentView([
      row({ sessionId: 'a', state: 'completed', workersAlive: 0 }),
      row({ sessionId: 'b', state: 'failed', workersAlive: 0 }),
    ]);

    const completed = view.rows.find((entry) => entry.sessionId === 'a');
    const failed = view.rows.find((entry) => entry.sessionId === 'b');
    expect(completed?.marker).toBe('idle-mark');
    expect(failed?.marker).toBe('error-mark');
  });

  it('marks a job as running only while its worker process is alive', () => {
    // The whole distinction between `✻` and `∙` is process liveness, not the
    // last recorded state — otherwise a job that is working reads as resting.
    const alive = buildAgentView([row({ state: 'working', workersAlive: 1 })]);
    const gone = buildAgentView([row({ state: 'working', workersAlive: 0 })]);

    expect(alive.rows[0]?.marker).toBe('busy-mark');
    expect(gone.rows[0]?.marker).toBe('idle-mark');
  });

  it('marks a paused queue on the row instead of clearing it', () => {
    const view = buildAgentView([row({ queuePaused: true })]);
    expect(view.rows[0]?.flags).toContain('queue-paused');
  });

  it('sorts rows stably inside a group', () => {
    // Rows must not jump around as states change, or the selection follows them.
    const view = buildAgentView([
      row({ sessionId: 'z', state: 'working' }),
      row({ sessionId: 'a', state: 'working' }),
    ]);
    expect(view.rows.map((entry) => entry.sessionId)).toEqual(['a', 'z']);
  });

  it('keeps the selection on the same row when an unrelated row changes', () => {
    const before = buildAgentView([
      row({ sessionId: 'a', state: 'working' }),
      row({ sessionId: 'b', state: 'working' }),
    ]);
    const after = buildAgentView([
      row({ sessionId: 'a', state: 'working' }),
      row({ sessionId: 'b', state: 'needs-input' }),
    ]);

    // `b` moved to the top group, so index 1 now points at `a`; a view that keys
    // the cursor on the index would silently select something else.
    expect(after.rows[0]?.sessionId).toBe('b');
    expect(before.rows[1]?.sessionId).toBe('b');
  });
});

describe('footer awaiting badge', () => {
  it('counts only the jobs that are waiting on the user', () => {
    // The badge is a promise that something needs a human, not a job counter.
    const badge = awaitingBadge(
      [
        row({ sessionId: 'a', state: 'needs-input' }),
        row({ sessionId: 'b', state: 'working' }),
        row({ sessionId: 'c', state: 'idle' }),
      ],
      true,
    );
    expect(badge).toEqual({ visible: true, count: 1 });
  });

  it('hides itself when nothing is waiting', () => {
    expect(awaitingBadge([row({ state: 'working' })], true)).toEqual({
      visible: false,
      count: 0,
    });
  });

  it('hides itself when no supervisor is reachable', () => {
    // A badge that could not ask must not claim "nothing is waiting".
    expect(awaitingBadge([row({ state: 'needs-input' })], false)).toEqual({
      visible: false,
      count: 0,
    });
  });

  it('counts more than one waiter', () => {
    const badge = awaitingBadge(
      [row({ sessionId: 'a', state: 'needs-input' }), row({ sessionId: 'b', state: 'needs-input' })],
      true,
    );
    expect(badge.count).toBe(2);
  });
});
