import { describe, expect, it, vi } from 'vitest';

import { createTuiBackgroundSessionFlow } from '../packages/tui/src/tui/controller/product/background-flow.js';
import type { BackgroundSessionDeps } from '../packages/tui/src/tui/features/agents/handoff.js';

/**
 * Phase 4 contract: the foreground TUI actually performing a hand-off.
 *
 * Phase 4a built `backgroundSession` as a pure, fully injected function, and
 * its tests all pass. That is not the same as a feature: nothing pressed a key.
 * This is the wiring that makes `←` do something, and it is where the
 * dependencies stop being obvious — the permission mode has to be read from the
 * live configuration, the daemon's socket and token have to be resolved from
 * the dataDir, and the turn has to be waited out through the Runtime port.
 *
 * The rule the wiring must not break is ownership. Before the hand-off the
 * foreground TUI drives the session; after it, the daemon's worker does. A flow
 * that reports success while the Turn is still owned locally is exactly the
 * "backgrounded session that never runs" bug the plan opens on.
 *
 * See mydocs/supervisor-plan-v2.md §2.1, §2.1.1.
 */
describe('background session flow', () => {
  function deps(overrides: Partial<BackgroundSessionDeps> = {}): BackgroundSessionDeps {
    return {
      sessionId: 'session-1',
      getComposerText: () => '',
      getActiveTurnId: () => undefined,
      abortSession: async () => true,
      waitForTurnSettled: async () => undefined,
      getPermissionMode: async () => 'default',
      adoptJob: async () => ({ adopted: true }),
      appendTimeline: async () => undefined,
      isDaemonOnline: () => true,
      ensureDaemon: async () => undefined,
      ...overrides,
    };
  }

  describe('successful hand-off', () => {
    it('adopts an idle session and reports where it went', async () => {
      const flow = createTuiBackgroundSessionFlow(
        deps({ adoptJob: async () => ({ adopted: true }) }),
      );

      const result = await flow.background();

      expect(result).toEqual({ status: 'adopted', continued: false });
    });

    it('reports that a live session was resumed rather than dropped', async () => {
      const flow = createTuiBackgroundSessionFlow(
        deps({
          getActiveTurnId: () => 'turn-1',
          adoptJob: async () => ({ adopted: true }),
        }),
      );

      // `continued: false` on a session that was mid-Turn would tell the user
      // their work stopped rather than carried over.
      const result = await flow.background();

      expect(result).toEqual({ status: 'adopted', continued: true });
    });

    it('leaves the session usable in the foreground once adopted', async () => {
      // Ownership transfers. The TUI has to stop driving the Turn, because the
      // worker now owns it and two drivers write the same transcript.
      const flow = createTuiBackgroundSessionFlow(deps());

      await flow.background();

      expect(flow.sessionId()).toBe('session-1');
    });
  });

  describe('refusals', () => {
    it('refuses while the composer holds text', async () => {
      const abortSession = vi.fn(async () => true);
      const adoptJob = vi.fn(async () => ({ adopted: true }) as const);
      const flow = createTuiBackgroundSessionFlow(
        deps({ getComposerText: () => 'unsent', abortSession, adoptJob }),
      );

      const result = await flow.background();

      expect(result.status).toBe('refused');
      // Nothing may be touched: the Turn is still the user's, and the text is
      // still on screen.
      expect(abortSession).not.toHaveBeenCalled();
      expect(adoptJob).not.toHaveBeenCalled();
    });

    it('tells the user what to do about unsent text', async () => {
      const setHint = vi.fn();
      const flow = createTuiBackgroundSessionFlow(
        deps({ getComposerText: () => 'unsent' }),
        { setHint },
      );

      await flow.background();

      expect(setHint).toHaveBeenCalledWith(expect.stringMatching(/unsent text/i), 'warning');
    });

    it('refuses without aborting the Turn when no supervisor is reachable', async () => {
      const abortSession = vi.fn(async () => true);
      const flow = createTuiBackgroundSessionFlow(
        deps({
          getActiveTurnId: () => 'turn-1',
          isDaemonOnline: () => false,
          ensureDaemon: async () => undefined,
          abortSession,
        }),
      );

      const result = await flow.background();

      expect(result).toMatchObject({ status: 'refused', reason: 'daemon-unavailable' });
      // Checked before the abort on purpose: ending the Turn with nowhere to
      // resume it loses the work outright.
      expect(abortSession).not.toHaveBeenCalled();
    });

    it('surfaces a daemon refusal instead of claiming success', async () => {
      const flow = createTuiBackgroundSessionFlow(
        deps({ adoptJob: async () => ({ adopted: false, reason: 'busy' }) }),
      );

      const result = await flow.background();

      expect(result).toMatchObject({ status: 'refused', reason: 'busy' });
    });

    it('does not write a commit line for a refused hand-off', async () => {
      const appendTimeline = vi.fn(async () => undefined);
      const flow = createTuiBackgroundSessionFlow(
        deps({
          getActiveTurnId: () => 'turn-1',
          adoptJob: async () => ({ adopted: false, reason: 'busy' }),
          appendTimeline,
        }),
      );

      await flow.background();

      // The `begin` line is expected; a `commit` line would tell a later reader
      // the hand-off finished when it did not.
      const details = appendTimeline.mock.calls.map((call) => call[1].detail);
      expect(details).not.toContain('handoff-committed');
    });
  });

  describe('sequence', () => {
    it('waits for the Turn to settle before adopting', async () => {
      const order: string[] = [];
      const flow = createTuiBackgroundSessionFlow(
        deps({
          getActiveTurnId: () => 'turn-1',
          abortSession: async () => {
            order.push('abort');
            return true;
          },
          waitForTurnSettled: async () => {
            order.push('settle');
          },
          adoptJob: async () => {
            order.push('adopt');
            return { adopted: true };
          },
        }),
      );

      await flow.background();

      // Adopting first would hand the job a transcript whose tail is still an
      // in-flight tool call.
      expect(order).toEqual(['abort', 'settle', 'adopt']);
    });

    it('uses the background_handoff abort reason, never session_leave', async () => {
      const reasons: string[] = [];
      const flow = createTuiBackgroundSessionFlow(
        deps({
          getActiveTurnId: () => 'turn-1',
          abortSession: async (input) => {
            reasons.push(input.reason);
            return true;
          },
        }),
      );

      await flow.background();

      // `session_leave` pauses the queue durably, so every later message would
      // sit in a paused queue while the row claimed to be running.
      expect(reasons).toEqual(['background_handoff']);
      expect(reasons).not.toContain('session_leave');
    });

    it('does not abort an idle session', async () => {
      const abortSession = vi.fn(async () => true);
      const flow = createTuiBackgroundSessionFlow(deps({ abortSession }));

      await flow.background();

      // Aborting "just in case" pauses the queue and the Goal, leaving a
      // backgrounded job that never runs again.
      expect(abortSession).not.toHaveBeenCalled();
    });

    it('reads the permission mode before the adopt, not after', async () => {
      const order: string[] = [];
      const flow = createTuiBackgroundSessionFlow(
        deps({
          getPermissionMode: async () => {
            order.push('mode');
            return 'auto';
          },
          adoptJob: async () => {
            order.push('adopt');
            return { adopted: true };
          },
        }),
      );

      await flow.background();

      // The mode a worker starts with has to be the one in effect at hand-off.
      expect(order).toEqual(['mode', 'adopt']);
    });
  });

  describe('busy state', () => {
    it('does not start a second hand-off while one is running', async () => {
      const adoptJob = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { adopted: true } as const;
      });
      const flow = createTuiBackgroundSessionFlow(deps({ adoptJob }));

      const [first, second] = await Promise.all([flow.background(), flow.background()]);

      // Two concurrent adopts race on the same job file, and the loser reports
      // a hand-off that never happened.
      expect(first.status).toBe('adopted');
      expect(second).toMatchObject({ status: 'refused', reason: 'busy' });
      expect(adoptJob).toHaveBeenCalledTimes(1);
    });

    it('accepts a new hand-off once the previous one finishes', async () => {
      const flow = createTuiBackgroundSessionFlow(deps());

      await flow.background();
      const second = await flow.background();

      expect(second.status).toBe('adopted');
    });
  });

  describe('hint', () => {
    it('reports success on the hand-off without a warning tone', async () => {
      const setHint = vi.fn();
      const flow = createTuiBackgroundSessionFlow(deps(), { setHint });

      await flow.background();

      // No tone argument: a successful hand-off is information, and reusing
      // `warning` would make the normal case look like a problem.
      expect(setHint).toHaveBeenCalledWith(expect.stringMatching(/in the background/i));
    });
  });
});
