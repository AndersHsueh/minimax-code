import { describe, expect, it, vi } from 'vitest';

import { attachSession } from '../packages/tui/src/tui/features/agents/attach.js';

/**
 * Phase 4 contract: attach v1 is a transfer of the driving position.
 *
 * A session in the background is driven by a worker process. Attaching it means
 * becoming the thing that drives it, not opening a window onto a worker. That
 * distinction is the whole scope of v1, and the plan is explicit that remote
 * live rendering is Phase 5.
 *
 * Two cases, and they are not variations of each other:
 *
 *  - **A, no live worker.** The TUI takes over completely. The plan is specific
 *    that every slash command works afterwards, because the foreground TUI
 *    rewrites history into the current terminal's scrollback. A view that
 *    imposed a read-only mode here would be inventing a constraint the product
 *    does not have.
 *  - **B, worker still running.** The TUI does *not* take over. It opens a
 *    read-only peek, Enter queues rather than submits, and `Ctrl+C` stops the
 *    job. Taking ownership here would put two drivers on one transcript.
 *
 * The refusal case matters as much: a session already attached elsewhere is not
 * stealable, because both holders would believe they own the queue.
 *
 * See mydocs/supervisor-plan-v2.md §3.7, §3.7.1.
 */
describe('attach v1', () => {
  function deps(overrides: Partial<Parameters<typeof attachSession>[0]> = {}) {
    return {
      sessionId: 'session-1',
      attach: vi.fn(async () => ({ owner: 'client' as const, live: false })),
      loadSessionProjection: vi.fn(async () => undefined),
      attachCommit: vi.fn(async () => ({ attached: true })),
      peek: vi.fn(async () => ({ owner: 'worker' as const, live: true, events: [] })),
      onOpenAgentView: vi.fn(),
      onNotify: vi.fn(),
      ...overrides,
    };
  }

  describe('case A — no live worker', () => {
    it('takes ownership of the session', async () => {
      const result = await attachSession(deps());

      expect(result).toMatchObject({ mode: 'owned' });
    });

    it('rebuilds the session from its durable projection', async () => {
      // The TUI process has no in-memory state for a session it did not start.
      // Without this the composer opens on an empty transcript and the user's
      // first message continues a conversation they cannot see.
      const d = deps();
      await attachSession(d);

      expect(d.loadSessionProjection).toHaveBeenCalledWith('session-1');
    });

    it('commits the takeover so the daemon knows who drives it', async () => {
      const d = deps();
      await attachSession(d);

      expect(d.attachCommit).toHaveBeenCalledWith('session-1');
    });

    it('rebuilds before it commits', async () => {
      // Committing first leaves a window where the daemon believes the TUI owns
      // a session whose history has not been loaded yet — a message sent into
      // that window lands with no visible context.
      const order: string[] = [];
      const d = deps({
        loadSessionProjection: async () => {
          order.push('load');
        },
        attachCommit: async () => {
          order.push('commit');
          return { attached: true };
        },
      });

      await attachSession(d);

      expect(order).toEqual(['load', 'commit']);
    });

    it('leaves the session fully interactive, not read-only', async () => {
      const result = await attachSession(deps());

      // v1 hands over an ordinary foreground session: slash commands, plan
      // mode, everything.
      expect(result).toMatchObject({ mode: 'owned', readOnly: false });
    });

    it('does not open the peek surface', async () => {
      const d = deps();
      await attachSession(d);

      expect(d.peek).not.toHaveBeenCalled();
    });

    it('opens the agent view rather than leaving the user where they were', async () => {
      const d = deps();
      await attachSession(d);

      expect(d.onOpenAgentView).toHaveBeenCalled();
    });
  });

  describe('case B — worker still running', () => {
    const live = () =>
      deps({ attach: vi.fn(async () => ({ owner: 'worker' as const, live: true })) });

    it('opens a live peek instead of taking over', async () => {
      const result = await attachSession(live());

      expect(result).toMatchObject({ mode: 'peek', live: true, readOnly: true });
    });

    it('does not commit the takeover', async () => {
      // The worker still owns the session. Committing would make the daemon
      // route the next message to a TUI that is only watching.
      const d = live();
      await attachSession(d);

      expect(d.attachCommit).not.toHaveBeenCalled();
    });

    it('does not rebuild the projection as if it owned the session', async () => {
      const d = live();
      await attachSession(d);

      expect(d.loadSessionProjection).not.toHaveBeenCalled();
    });

    it('tells the user the worker is still running', async () => {
      const d = live();
      await attachSession(d);

      expect(d.onNotify).toHaveBeenCalledWith(expect.stringMatching(/still running/i));
    });

    it('says the next turn happens automatically', async () => {
      const d = live();
      await attachSession(d);

      expect(d.onNotify).toHaveBeenCalledWith(expect.stringMatching(/automatically/i));
    });
  });

  describe('refusal', () => {
    it('refuses a session already attached elsewhere', async () => {
      const onNotify = vi.fn();
      const d = deps({
        attach: vi.fn(async () => ({
          owner: 'none' as const,
          live: false,
          reason: 'already-attached' as const,
        })),
        onNotify,
      });

      const result = await attachSession(d);

      expect(result).toMatchObject({ mode: 'refused' });
      expect(onNotify).toHaveBeenCalledWith(expect.stringMatching(/already|another/i));
    });

    it('does not load or commit when refused', async () => {
      const d = deps({
        attach: vi.fn(async () => ({
          owner: 'none' as const,
          live: false,
          reason: 'already-attached' as const,
        })),
      });

      await attachSession(d);

      expect(d.loadSessionProjection).not.toHaveBeenCalled();
      expect(d.attachCommit).not.toHaveBeenCalled();
    });
  });

  describe('failure', () => {
    it('reports an unreachable supervisor rather than claiming a takeover', async () => {
      const onNotify = vi.fn();
      const d = deps({
        attach: vi.fn(async () => {
          throw new Error('socket closed');
        }),
        onNotify,
      });

      const result = await attachSession(d);

      // The alternative — an "owned" result on a failed attach — leaves the user
      // typing into a session the daemon believes is still a worker's.
      expect(result).toMatchObject({ mode: 'failed' });
      expect(onNotify).toHaveBeenCalled();
    });

    it('does not commit when the projection cannot be rebuilt', async () => {
      const d = deps({
        loadSessionProjection: vi.fn(async () => {
          throw new Error('history unreadable');
        }),
      });

      const result = await attachSession(d);

      expect(result).toMatchObject({ mode: 'failed' });
      expect(d.attachCommit).not.toHaveBeenCalled();
    });
  });
});
