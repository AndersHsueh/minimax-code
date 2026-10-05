import { describe, expect, it, vi } from 'vitest';

import { backgroundSession, type BackgroundSessionDeps } from '../packages/tui/src/tui/features/agents/handoff.js';

/**
 * Phase 4 contract: what `←` on an empty composer actually does.
 *
 * The key looks like "send this session away" and is really the hardest flow in
 * the design, because a Turn runs **inside the foreground process**. It cannot
 * be moved. So backgrounding a live session means ending that Turn and having a
 * different process pick the work up from the durable transcript — and every
 * step in between can silently lose work.
 *
 * The rules that are not obvious:
 *
 *  - **A non-empty composer is refused.** Silently discarding the user's typing
 *    is worse than refusing.
 *  - **An idle session is adopted without aborting anything.** There is no Turn
 *    to end, and aborting "just in case" would pause the queue and the Goal —
 *    the exact failure §2.1 exists to prevent. A job that is backgrounded with a
 *    paused queue never runs again.
 *  - **A live session is handed off with `background_handoff`, not
 *    `session_leave`.** Reusing the session-switch path pauses the queue, and a
 *    durably paused queue never drains — so every message the supervisor later
 *    delivers to that job would sit there while the row claims to be running.
 *  - **The handoff is written to the timeline around the adoption.** A crash
 *    between the two leaves a job that is neither running nor resumable, and
 *    nothing on disk says so.
 *
 * See mydocs/supervisor-plan-v2.md §2.1, §2.1.1, and the guardrail "never reuse
 * the session-switch path for hand-off".
 */
describe('backgrounding a session', () => {
  function deps(overrides: Partial<BackgroundSessionDeps> = {}): BackgroundSessionDeps & {
    abortSession: ReturnType<typeof vi.fn>;
    adoptJob: ReturnType<typeof vi.fn>;
    getComposerText: ReturnType<typeof vi.fn>;
    getActiveTurnId: ReturnType<typeof vi.fn>;
    appendTimeline: ReturnType<typeof vi.fn>;
  } {
    const base = {
      sessionId: 'session-1',
      getComposerText: vi.fn(() => ''),
      getActiveTurnId: vi.fn(() => undefined),
      // `background_handoff` is the whole point; `session_leave` must never
      // appear here, and the test below fails loudly if it does.
      abortSession: vi.fn(async () => true),
      waitForTurnSettled: vi.fn(async () => undefined),
      getPermissionMode: vi.fn(async () => 'default' as const),
      adoptJob: vi.fn(async () => ({ adopted: true as const })),
      appendTimeline: vi.fn(async () => undefined),
      isDaemonOnline: vi.fn(() => true),
      ensureDaemon: vi.fn(async () => undefined),
      notify: vi.fn(),
      ...overrides,
    };
    return base as never;
  }

  it('refuses while the composer has unsent text', async () => {
    // The user's typing is the most recent thing they did. Discarding it silently
    // is the one outcome nobody would accept.
    const d = deps({ getComposerText: () => 'half-written thought' });

    const result = await backgroundSession(d);

    expect(result).toMatchObject({ status: 'refused', reason: 'composer-not-empty' });
    expect(d.abortSession).not.toHaveBeenCalled();
    expect(d.adoptJob).not.toHaveBeenCalled();
  });

  it('treats whitespace-only composer text as empty', async () => {
    const d = deps({ getComposerText: () => '   \n  ' });
    await expect(backgroundSession(d)).resolves.toMatchObject({ status: 'adopted' });
  });

  it('aborts nothing when the session is idle', async () => {
    // No Turn to end. Aborting "just in case" would pause the queue and the Goal,
    // and a backgrounded job with a paused queue never runs again.
    const d = deps({ getActiveTurnId: () => undefined });

    const result = await backgroundSession(d);

    expect(result).toMatchObject({ status: 'adopted', continued: false });
    expect(d.abortSession).not.toHaveBeenCalled();
  });

  it('adopts an idle session without asking it to continue', async () => {
    const d = deps();
    await backgroundSession(d);

    expect(d.adoptJob).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', handoff: { continue: false } }),
    );
  });

  it('uses background_handoff when a Turn is live', async () => {
    const d = deps({ getActiveTurnId: () => 'turn-1' });

    await backgroundSession(d);

    expect(d.abortSession).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'background_handoff' }),
    );
  });

  it('never falls back to session_leave for the hand-off', async () => {
    // The trap: `session_leave` is one keystroke away in the same file and does
    // exactly what a hand-off must not do.
    const d = deps({ getActiveTurnId: () => 'turn-1' });
    await backgroundSession(d);

    const reasons = d.abortSession.mock.calls.map(([input]) => (input as { reason: string }).reason);
    expect(reasons).not.toContain('session_leave');
  });

  it('waits for the Turn to settle before adopting', async () => {
    // Adopting first would hand the job to a worker that then has nothing to
    // continue, and the transcript is still being written.
    const order: string[] = [];
    const d = deps({
      getActiveTurnId: () => 'turn-1',
      abortSession: vi.fn(async () => {
        order.push('abort');
        return true;
      }),
      waitForTurnSettled: vi.fn(async () => {
        order.push('settled');
      }),
      adoptJob: vi.fn(async () => {
        order.push('adopt');
        return { adopted: true as const };
      }),
    });

    await backgroundSession(d);

    expect(order).toEqual(['abort', 'settled', 'adopt']);
  });

  it('asks the worker to continue a Turn it interrupted', async () => {
    const d = deps({ getActiveTurnId: () => 'turn-1' });
    const result = await backgroundSession(d);

    expect(result).toMatchObject({ status: 'adopted', continued: true });
    expect(d.adoptJob).toHaveBeenCalledWith(
      expect.objectContaining({ handoff: { continue: true } }),
    );
  });

  it('records the permission mode in effect at hand-off time', async () => {
    // Not the one a worker will find later. The whole respawn-safety rule
    // depends on this value being captured now.
    const d = deps({ getPermissionMode: vi.fn(async () => 'auto' as const) });
    await backgroundSession(d);

    expect(d.adoptJob).toHaveBeenCalledWith(
      expect.objectContaining({ launch: expect.objectContaining({ permissionMode: 'auto' }) }),
    );
  });

  it('writes handoff-begin before adopting and handoff-committed after', async () => {
    // A crash between the two leaves a job that is neither running nor
    // resumable, and nothing on disk says so.
    const d = deps({ getActiveTurnId: () => 'turn-1' });
    await backgroundSession(d);

    const states = d.appendTimeline.mock.calls.map(([, entry]) => (entry as { detail?: string }).detail);
    expect(states).toEqual(['handoff-begin', 'handoff-committed']);
  });

  it('does not write handoff-committed when the adoption is refused', async () => {
    const d = deps({
      getActiveTurnId: () => 'turn-1',
      adoptJob: vi.fn(async () => ({ adopted: false as const, reason: 'no-daemon' as const })),
    });

    const result = await backgroundSession(d);

    expect(result).toMatchObject({ status: 'refused', reason: 'no-daemon' });
    const states = d.appendTimeline.mock.calls.map(([, entry]) => (entry as { detail?: string }).detail);
    expect(states).toEqual(['handoff-begin']);
  });

  it('refuses rather than starting a session with no supervisor', async () => {
    // Backgrounding into nothing would leave the user with a session that is
    // running nowhere and looks fine.
    const d = deps({ isDaemonOnline: () => false });

    const result = await backgroundSession(d);

    expect(result).toMatchObject({ status: 'refused', reason: 'daemon-unavailable' });
    expect(d.adoptJob).not.toHaveBeenCalled();
  });

  it('starts the supervisor first when it is merely not running yet', async () => {
    // Not running and unreachable are different: the first is a normal state on
    // first use and the supervisor is supposed to come up on demand.
    let online = false;
    const ensureDaemon = vi.fn(async () => {
      online = true;
    });
    const d = deps({ isDaemonOnline: () => online, ensureDaemon });

    const result = await backgroundSession(d);

    expect(ensureDaemon).toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'adopted' });
  });

  it('keeps the foreground process alive when the hand-off fails', async () => {
    // The user is still looking at this session. Releasing it while the job was
    // never adopted would lose the Turn outright.
    const d = deps({
      getActiveTurnId: () => 'turn-1',
      adoptJob: vi.fn(async () => ({ adopted: false as const, reason: 'busy' as const })),
    });

    const result = await backgroundSession(d);

    expect(result).toMatchObject({ status: 'refused' });
  });

  it('does not abort a Turn it is not going to hand off', async () => {
    // Ordering hazard: aborting before checking the supervisor would kill the
    // Turn and then discover there is nowhere to resume it.
    const d = deps({ getActiveTurnId: () => 'turn-1', isDaemonOnline: () => false });

    await backgroundSession(d);

    expect(d.abortSession).not.toHaveBeenCalled();
  });
});
