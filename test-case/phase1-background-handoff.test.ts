import { describe, expect, it } from 'vitest';

import { normalizeAbortSource } from '@mavis/agent-core/pi-turn-runner';

import { pausesQueueOnAbort } from '../packages/local-runtime-v2/src/service/turn-system/execution/queue-pause-on-abort.js';

/**
 * Phase 1 contract: `background_handoff` — the abort source used when a
 * foreground TUI session is handed off to a background worker.
 *
 * A hand-off MUST stop the live Turn, because a Turn runs inside the
 * foreground process's embedded runtime and cannot migrate to another process.
 * It must NOT pause the queue or the Goal, because the whole point of the
 * hand-off is that the worker keeps draining work the user already queued.
 * It must NOT cascade into background work, exactly like `session_leave`.
 *
 * Rationale and the failure this prevents: if a hand-off paused the queue the
 * same way `session_leave` does, every message the supervisor later delivers to
 * a backgrounded session would land in a durably paused queue and never run.
 * See mydocs/supervisor-plan-v2.md §2.1 and §零之二.
 */
describe('background_handoff', () => {
  it('normalizes to its own abort source rather than collapsing to unknown', () => {
    expect(normalizeAbortSource('background_handoff')).toBe('background_handoff');
  });

  it('is a bounded, documented member of AbortSource', () => {
    // A hand-off is a product decision, not a runtime accident: an un-normalized
    // value must never be able to masquerade as one.
    const bounded: readonly string[] = [
      'user_stop',
      'session_leave',
      'background_handoff',
      'immediate_send',
      'input_safety',
      'output_safety',
      'lifecycle',
    ];
    for (const source of bounded) {
      expect(normalizeAbortSource(source)).toBe(source);
    }
  });

  it('stops the Turn but leaves the queue draining', () => {
    // The regression this guards: a hand-off that paused the queue would wedge
    // every backgrounded session permanently.
    expect(pausesQueueOnAbort('background_handoff')).toBe(false);
  });

  it('is unaffected by the raw un-normalized spellings of the other sources', () => {
    // `session_leave` pauses; the same-shaped raw strings do not. This keeps the
    // predicate honest: only the two user-attention-loss sources pause.
    expect(pausesQueueOnAbort('session_leave')).toBe(true);
    expect(pausesQueueOnAbort('user_stop')).toBe(true);
    expect(pausesQueueOnAbort('background-handoff')).toBe(false);
    expect(pausesQueueOnAbort('backgroundHandoff')).toBe(false);
    expect(pausesQueueOnAbort(undefined)).toBe(false);
  });
});
