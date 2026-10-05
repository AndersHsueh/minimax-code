import { describe, expect, it, vi } from 'vitest';

import { waitForTurnSettled } from '../packages/tui/src/tui/features/agents/turn-settlement.js';
import type { TuiActiveRunSnapshot } from '../packages/tui/src/runtime/port.js';

/**
 * Phase 4 contract: waiting for an aborted Turn to reach disk.
 *
 * §2.1 is blunt about why this step exists. A Turn runs inside the foreground
 * process and cannot be moved, so backgrounding a live session means ending that
 * Turn and letting a different process resume from the durable transcript. The
 * abort has to have *landed* before the daemon adopts, or the new process reads
 * a history whose tail is still an in-flight tool call, decides there is nothing
 * to continue, and the session sits idle forever while the row says it is
 * working.
 *
 * The asymmetry here is the whole design. Timing out is safe: the adopt still
 * happens and the timeline records it, so the state is visible and recoverable.
 * Returning early is not — it is the silent version of the bug above. So the
 * poll gives up and says so, rather than the caller proceeding as if it settled.
 *
 * See mydocs/supervisor-plan-v2.md §2.1, §2.1.1.
 */
describe('waitForTurnSettled', () => {
  function run(state: TuiActiveRunSnapshot['state'], turnId = 'turn-1'): TuiActiveRunSnapshot {
    return { schemaVersion: 1, sessionId: 'session-1', state, turnId, actions: { steer: false } };
  }

  it('resolves once the Turn leaves the running state', async () => {
    const states = [run('running'), run('running'), run('terminal')];
    const getActiveRun = vi.fn(async () => states.shift() as TuiActiveRunSnapshot);

    await waitForTurnSettled({
      sessionId: 'session-1',
      getActiveRun,
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(getActiveRun).toHaveBeenCalledTimes(3);
  });

  it('treats a decision-blocked Turn as still running', async () => {
    // `decision-blocked` means the Turn is parked on a permission request. It
    // has not settled, and a hand-off that treats it as terminal would adopt a
    // session whose transcript is still mid-turn.
    const states = [run('decision-blocked'), run('terminal')];
    const getActiveRun = vi.fn(async () => states.shift() as TuiActiveRunSnapshot);

    const result = await waitForTurnSettled({
      sessionId: 'session-1',
      getActiveRun,
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(result.settled).toBe(true);
    expect(getActiveRun).toHaveBeenCalledTimes(2);
  });

  it('resolves immediately when the Turn is already terminal', async () => {
    const getActiveRun = vi.fn(async () => run('terminal'));

    const result = await waitForTurnSettled({
      sessionId: 'session-1',
      getActiveRun,
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(result.settled).toBe(true);
    expect(getActiveRun).toHaveBeenCalledTimes(1);
  });

  it('gives up on a Turn that never settles and says so', async () => {
    const getActiveRun = vi.fn(async () => run('running'));

    const result = await waitForTurnSettled({
      sessionId: 'session-1',
      getActiveRun,
      intervalMs: 1,
      timeoutMs: 20,
    });

    // The caller still proceeds with the adopt. What it must not do is treat
    // this as a clean hand-off.
    expect(result.settled).toBe(false);
  });

  it('stops asking once the Turn has settled', async () => {
    const getActiveRun = vi.fn(async () => run('terminal'));

    await waitForTurnSettled({
      sessionId: 'session-1',
      getActiveRun,
      intervalMs: 1,
      timeoutMs: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // A poll that keeps running after the answer is a background task that
    // outlives the TUI and holds a runtime handle open.
    expect(getActiveRun).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the runtime cannot be inspected', async () => {
    const getActiveRun = vi.fn(async () => {
      throw new Error('runtime is gone');
    });

    const result = await waitForTurnSettled({
      sessionId: 'session-1',
      getActiveRun,
      intervalMs: 1,
      timeoutMs: 50,
    });

    // An unreachable runtime is reported, not thrown. The hand-off flow is
    // already mid-sequence; an exception here would strand the session between
    // an aborted Turn and no job.
    expect(result.settled).toBe(false);
  });

  it('retries a failed inspection rather than giving up on the first error', async () => {
    let calls = 0;
    const getActiveRun = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return run('terminal');
    });

    const result = await waitForTurnSettled({
      sessionId: 'session-1',
      getActiveRun,
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(result.settled).toBe(true);
  });

  it('waits at least one interval before re-inspecting', async () => {
    const getActiveRun = vi.fn(async () => run('terminal'));
    const at = Date.now();

    await waitForTurnSettled({
      sessionId: 'session-1',
      getActiveRun,
      intervalMs: 40,
      timeoutMs: 1_000,
    });

    // A zero-delay poll against a runtime that is mid-write is how a TUI ends
    // up spinning the CPU during a hand-off the user already sees as instant.
    expect(Date.now() - at).toBeLessThan(40);
  });

  it('reports the session it was waiting on', async () => {
    const getActiveRun = vi.fn(async () => run('terminal'));

    const result = await waitForTurnSettled({
      sessionId: 'session-42',
      getActiveRun,
      intervalMs: 1,
      timeoutMs: 1_000,
    });

    expect(result.sessionId).toBe('session-42');
  });
});
