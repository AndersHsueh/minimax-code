import { describe, expect, it, vi } from 'vitest';

import { createRecoveryPolicy } from '../packages/tui/src/daemon/recovery.js';
import { closeWorkerGracefully } from '../packages/tui/src/daemon/shutdown.js';
import { resolveWorkerLaunch } from '../packages/tui/src/daemon/launch-policy.js';

/**
 * Phase 3 contract: what happens when a worker dies, and how one is shut down.
 *
 * **Shutdown.** Phase 0' measured all three ways of stopping a worker, and they
 * are not variations on a theme:
 *
 * | how | prompt settles | `queue_pauses` | queued items end up |
 * | --- | --- | --- | --- |
 * | `session/cancel` | `cancelled` in 59ms | `user-stop` row written | `paused` |
 * | close stdin | never settles (45s) | no row | still `queued` |
 * | SIGTERM | never settles (45s) | no row | still `queued` |
 *
 * A leftover `queued` item re-fires when the worker is next started — so a user
 * who stopped a session watches it keep working, in a process they believe is
 * gone. SIGTERM is therefore not a graceful stop, and using it as one is the
 * single most dangerous shortcut available here.
 *
 * **Recovery.** A crash while a prompt was in flight is recoverable: the
 * transcript is durable and `mcode/session/continue` picks the Turn back up. A
 * crash while idle is not a failure at all, and restarting it would start work
 * nobody asked for. The restart budget exists so a worker that cannot start —
 * a bad model, a revoked key — fails visibly instead of looping forever.
 *
 * **Permission mode.** This is the security property. Permission mode is global
 * and its read cache is per-process, so a respawned worker re-reads
 * `config.yaml`. If another terminal widened the mode in between, the job
 * silently inherits a wider one. A respawn may only ever use what the job
 * recorded at creation, and a missing record fails closed.
 *
 * See mydocs/supervisor-plan-v2.md §2.2, §3.9.1, §3.9.2.
 */
describe('worker recovery', () => {
  describe('restart policy', () => {
    it('restarts a worker that crashed mid-prompt', () => {
      const policy = createRecoveryPolicy({ now: () => 0 });
      expect(policy.onExit({ code: null, signal: 'SIGKILL', promptInFlight: true })).toMatchObject({
        action: 'restart',
        continueRun: true,
      });
    });

    it('restarts a non-zero exit the same way', () => {
      const policy = createRecoveryPolicy({ now: () => 0 });
      expect(policy.onExit({ code: 137, signal: null, promptInFlight: true })).toMatchObject({
        action: 'restart',
      });
    });

    it('does not restart a worker that was stopped on purpose', () => {
      const policy = createRecoveryPolicy({ now: () => 0 });
      expect(policy.onExit({ code: 0, signal: null, promptInFlight: true, requested: true })).toEqual({
        action: 'none',
        reason: 'requested',
      });
    });

    it('does not restart a worker that exited cleanly', () => {
      const policy = createRecoveryPolicy({ now: () => 0 });
      expect(policy.onExit({ code: 0, signal: null, promptInFlight: false }).action).toBe('none');
    });

    it('does not restart a worker that crashed while idle', () => {
      // Nothing was in flight, so there is nothing to resume. Restarting would
      // start a process for a job that had already finished.
      const policy = createRecoveryPolicy({ now: () => 0 });
      expect(policy.onExit({ code: 1, signal: null, promptInFlight: false })).toMatchObject({
        action: 'none',
      });
    });

    it('backs off further after each restart', () => {
      let now = 0;
      const policy = createRecoveryPolicy({ now: () => now });
      const first = policy.onExit({ code: 1, signal: null, promptInFlight: true });
      now += 60_000;
      const second = policy.onExit({ code: 1, signal: null, promptInFlight: true });

      expect(first).toMatchObject({ backoffMs: 5_000 });
      expect(second).toMatchObject({ backoffMs: 30_000 });
    });

    it('gives up after the restart budget and fails the job', () => {
      // A worker that cannot start at all — revoked key, deleted model — would
      // otherwise retry forever and look like it was working.
      let now = 0;
      const policy = createRecoveryPolicy({ now: () => now });
      const outcomes = [
        policy.onExit({ code: 1, signal: null, promptInFlight: true }),
        policy.onExit({ code: 1, signal: null, promptInFlight: true }),
        policy.onExit({ code: 1, signal: null, promptInFlight: true }),
      ];
      expect(outcomes[0]?.action).toBe('restart');
      expect(outcomes[1]?.action).toBe('restart');
      expect(outcomes[2]).toMatchObject({ action: 'fail' });
    });

    it('forgets old crashes once the window has passed', () => {
      let now = 0;
      const policy = createRecoveryPolicy({ now: () => now, windowMs: 600_000 });
      policy.onExit({ code: 1, signal: null, promptInFlight: true });
      now += 700_000;
      // A crash an hour later is a fresh incident, not the third of three.
      expect(policy.onExit({ code: 1, signal: null, promptInFlight: true }).action).toBe('restart');
    });

    it('records why a job failed so the detail is not just "crashed"', () => {
      const policy = createRecoveryPolicy({ now: () => 0 });
      policy.onExit({ code: 137, signal: null, promptInFlight: true });
      policy.onExit({ code: 137, signal: null, promptInFlight: true });
      const outcome = policy.onExit({ code: 137, signal: null, promptInFlight: true });
      expect(outcome).toMatchObject({ action: 'fail' });
      expect('detail' in outcome && outcome.detail).toContain('137');
    });
  });

  describe('graceful shutdown', () => {
    function worker(overrides: Record<string, unknown> = {}) {
      const cancel = vi.fn(async () => ({ stopReason: 'cancelled' as const }));
      const activity = vi.fn(async () => ({ queuePaused: true, queuePending: 0 }));
      const close = vi.fn();
      return { worker: { cancel, activity, close, ...overrides }, cancel, activity, close };
    }

    it('cancels the prompt first and closes after it settles', async () => {
      // The order is the fix. SIGTERM leaves queued items that re-fire later.
      const { worker: fake, cancel, activity, close } = worker();

      const result = await closeWorkerGracefully({
        worker: fake as never,
        cancelTimeoutMs: 3_000,
      });

      expect(cancel).toHaveBeenCalled();
      expect(activity).toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
      expect(result.queueConfirmedPaused).toBe(true);
    });

    it('closes after cancel settles, never before', async () => {
      const order: string[] = [];
      const { worker: fake } = worker({
        cancel: async () => {
          order.push('cancel');
          return { stopReason: 'cancelled' as const };
        },
        activity: async () => {
          order.push('activity');
          return { queuePaused: true, queuePending: 0 };
        },
      });

      await closeWorkerGracefully({
        worker: { ...fake, close: () => order.push('close') } as never,
        cancelTimeoutMs: 3_000,
      });

      expect(order).toEqual(['cancel', 'activity', 'close']);
    });

    it('still closes when cancel does not settle in time', async () => {
      // A hung prompt must not wedge the daemon's shutdown path.
      const { worker: fake, close } = worker({
        cancel: () => new Promise(() => undefined),
      });

      const result = await closeWorkerGracefully({
        worker: fake as never,
        cancelTimeoutMs: 20,
      });

      expect(close).toHaveBeenCalled();
      expect(result).toMatchObject({ cancelled: false, timedOut: true });
    });

    it('reports an unconfirmed queue rather than claiming a clean stop', async () => {
      // If the queue did not reach `paused`, leftover items will re-fire on the
      // next start. That has to be visible rather than swallowed.
      const { worker: fake, close } = worker({
        activity: async () => ({ queuePaused: false, queuePending: 3 }),
      });

      const result = await closeWorkerGracefully({
        worker: fake as never,
        cancelTimeoutMs: 3_000,
      });

      expect(close).toHaveBeenCalled();
      expect(result).toMatchObject({ queueConfirmedPaused: false, pendingItems: 3 });
    });

    it('closes even when the activity probe itself fails', async () => {
      const { worker: fake, close } = worker({
        activity: async () => {
          throw new Error('runtime gone');
        },
      });

      const result = await closeWorkerGracefully({
        worker: fake as never,
        cancelTimeoutMs: 3_000,
      });

      expect(close).toHaveBeenCalled();
      expect(result.queueConfirmedPaused).toBe(false);
    });
  });

  describe('launch pinning', () => {
    const job = { launch: { permissionMode: 'default', model: 'p/m' } };

    it('uses the permission mode recorded when the job was created', () => {
      // The whole point: another terminal widening the global mode must not
      // reach this job on its next respawn.
      const launch = resolveWorkerLaunch({
        job,
        globalPermissionMode: 'bypassPermissions',
      });
      expect(launch.permissionMode).toBe('default');
    });

    it('keeps the recorded model when the global selection has moved', () => {
      const launch = resolveWorkerLaunch({
        job,
        globalPermissionMode: 'bypassPermissions',
        globalModel: 'other/model',
      });
      expect(launch.model).toBe('p/m');
    });

    it('fails closed when the job recorded no mode', () => {
      // A job with no recorded mode has no safe default. Reading the global one
      // is exactly the drift this exists to prevent.
      expect(() => resolveWorkerLaunch({ job: {}, globalPermissionMode: 'bypassPermissions' })).toThrow(
        /permission/i,
      );
    });

    it('never returns a mode wider than the one recorded', () => {
      for (const global of ['bypassPermissions', 'auto', 'off', 'default'] as const) {
        const launch = resolveWorkerLaunch({ job, globalPermissionMode: global });
        expect(launch.permissionMode).toBe('default');
      }
    });

    it('carries the lane so a respawn lands in the same lane', () => {
      const launch = resolveWorkerLaunch({ job: { ...job, lane: 'work' }, globalPermissionMode: 'auto' });
      expect(launch.lane).toBe('work');
    });

    it('omits the model flags entirely when the job recorded none', () => {
      const launch = resolveWorkerLaunch({
        job: { launch: { permissionMode: 'default' } },
        globalPermissionMode: 'default',
      });
      expect(launch.model).toBeUndefined();
      expect(launch.effort).toBeUndefined();
    });
  });
});
