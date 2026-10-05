import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createWorkerHost, type WorkerHostOptions } from '../packages/tui/src/daemon/worker-host.js';
import { resolveWorkerLaunch } from '../packages/tui/src/daemon/launch-policy.js';

/**
 * Phase 3 contract: the worker host, driven by a fake process.
 *
 * A worker is a `mcode acp` child speaking JSON-RPC over stdio, and the daemon
 * is its ACP client. The host owns the parts that decide whether work keeps
 * running unattended:
 *
 *  - **launch values come from the job, not the environment** (`launch-policy`)
 *  - **the reclaim loop uses awake time**, so a sleeping laptop does not retire
 *    every job the moment it wakes
 *  - **a reclaim goes through `session/cancel` first**, because a leftover
 *    `queued` item re-fires on the next start
 *  - **an unexpected exit restarts with backoff, and only while a prompt was in
 *    flight**
 *
 * The fake child is a plain `EventEmitter` with scripted responses, so the
 * ordering guarantees can be asserted directly rather than inferred.
 *
 * See mydocs/supervisor-plan-v2.md §3.9.
 */
describe('worker host', () => {
  function harness(overrides: Partial<WorkerHostOptions> = {}) {
    const events: string[] = [];
    const requests: { method: string; params?: unknown }[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdin: { write(chunk: string): void; end(): void };
      kill(signal?: string): boolean;
      readonly killed: boolean;
    };
    const replies = new Map<string, (params: unknown) => unknown>();
    child.stdin = {
      write(chunk: string) {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line) as { id: number; method: string; params?: unknown };
          requests.push({ method: frame.method, params: frame.params });
          events.push(`req:${frame.method}`);
          const reply = replies.get(frame.method);
          if (reply) {
            child.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: reply(frame.params) })}\n`);
          }
        }
      },
      end() {
        events.push('stdin-end');
      },
    };
    let killed = false;
    child.kill = (signal?: string) => {
      killed = true;
      events.push(`kill:${signal ?? 'SIGTERM'}`);
      return true;
    };
    Object.defineProperty(child, 'killed', { get: () => killed });

    replies.set('session/cancel', () => ({ stopReason: 'cancelled' }));
    replies.set('mcode/worker/activity', () => ({
      runState: 'idle',
      queuePending: 0,
      queuePaused: false,
      goalActive: false,
      backgroundTasks: 0,
    }));
    replies.set('mcode/session/continue', () => ({ continued: true, turnId: 'turn-2' }));

    const spawn = vi.fn(() => child);
    const options: WorkerHostOptions = {
      sessionId: 'session-1',
      job: { launch: { permissionMode: 'default' } },
      spawn,
      now: () => 0,
      // Ticks reclaim immediately unless a test says otherwise; the timeout
      // itself gets its own case below.
      idleTimeoutMs: 0,
      ...overrides,
    };
    return { host: createWorkerHost(options), child, spawn, events, requests, replies };
  }

  it('starts the worker with the permission mode the job recorded', () => {
    // The global setting is never consulted; see launch-policy.
    const { host, spawn } = harness();
    host.start();

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(['--permission-mode', 'default']) as string[],
        detached: true,
      }),
    );
  });

  it('refuses to exist at all when the job records no permission mode', () => {
    // Failing at construction rather than at start: a host that cannot be
    // launched should not be constructible, so no caller can hold one and
    // forget.
    expect(() => harness({ job: {} })).toThrow(/permission/i);
  });

  it('does not reclaim a worker that still has a prompt in flight', () => {
    const { host } = harness();
    host.start();
    host.notePromptStarted('turn-1');

    host.tick();

    expect(host.state()).toMatchObject({ reclaimable: false, promptInFlight: true });
  });

  it('reclaims an idle worker through session/cancel, never a bare kill', async () => {
    // SIGTERM leaves queued items `queued`, and those re-fire on the next start.
    const { host, child, events } = harness();
    host.start();

    await host.tick();

    expect(events).toContain('req:session/cancel');
    expect(events).toContain('stdin-end');
    expect(events.some((entry) => entry.startsWith('kill:'))).toBe(false);
    expect(child.stdin).toBeDefined();
  });

  it('keeps a worker whose queue is about to dispatch', async () => {
    const { host, replies } = harness();
    replies.set('mcode/worker/activity', () => ({
      runState: 'idle',
      queuePending: 2,
      queuePaused: false,
      goalActive: false,
      backgroundTasks: 0,
    }));
    host.start();

    await host.tick();

    expect(host.state().reclaimable).toBe(false);
  });

  it('keeps a worker that owns a running background task', async () => {
    const { host, replies } = harness();
    replies.set('mcode/worker/activity', () => ({
      runState: 'idle',
      queuePending: 0,
      queuePaused: false,
      goalActive: false,
      backgroundTasks: 1,
    }));
    host.start();

    await host.tick();

    expect(host.state().reclaimable).toBe(false);
  });

  it('waits out the idle window before reclaiming', async () => {
    // Debounce: a worker that just went quiet after finishing a turn must not be
    // stopped immediately, or every message costs a process start.
    const now = vi.fn(() => 0);
    const { host, events } = harness({ now, idleTimeoutMs: 60_000 });
    host.start();

    await host.tick();
    expect(events).not.toContain('stdin-end');
    now.mockReturnValue(59_000);
    await host.tick();
    expect(events).not.toContain('stdin-end');
    now.mockReturnValue(60_000);
    await host.tick();
    expect(events).toContain('stdin-end');
  });

  it('restarts a crashed worker and continues the interrupted Turn', () => {
    const { host, child, spawn, events } = harness();
    host.start();
    host.notePromptStarted('turn-1');

    child.emit('exit', null, 'SIGKILL');

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(events).toContain('req:mcode/session/continue');
    expect(host.state()).toMatchObject({ promptInFlight: false, crashes: 1 });
  });

  it('does not restart a worker that exited cleanly', () => {
    const { host, spawn, child } = harness();
    host.start();

    child.emit('exit', 0, null);

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(host.state()).toMatchObject({ status: 'stopped' });
  });

  it('does not restart a worker that died while idle', () => {
    const { host, spawn, child } = harness();
    host.start();

    child.emit('exit', 1, null);

    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('fails the job after the restart budget instead of looping', () => {
    const { host, child, spawn } = harness();
    host.start();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      host.notePromptStarted('turn-1');
      child.emit('exit', 1, null);
    }

    // Three starts at most: the original plus the budgeted restarts.
    expect(spawn.mock.calls.length).toBeLessThanOrEqual(3);
    expect(host.state().status).toBe('failed');
    expect(host.failureDetail).toMatch(/crashed/i);
  });

  it('reports the job as needing input when a permission request is pending', () => {
    // `mcode send` must not be able to answer it; only an interactive client can.
    const { host } = harness();
    host.start();
    host.noteInteraction('perm-1');

    expect(host.state()).toMatchObject({ state: 'needs-input', pendingInteractions: 1 });
  });

  it('clears a pending interaction once it is answered', () => {
    const { host } = harness();
    host.start();
    host.noteInteraction('perm-1');
    host.resolveInteraction('perm-1');

    expect(host.state()).toMatchObject({ state: 'idle', pendingInteractions: 0 });
  });

  it('stops a worker that a client is watching only when told to', async () => {
    const { host, events } = harness();
    host.start();
    host.noteWatcher();

    await host.tick();
    expect(events).not.toContain('stdin-end');

    host.releaseWatcher();
    await host.tick();
    expect(events).toContain('stdin-end');
  });

  it('stops through cancel when the host is shut down explicitly', async () => {
    const { host, events } = harness();
    host.start();
    host.notePromptStarted('turn-1');

    await host.stop();

    expect(events).toContain('req:session/cancel');
    expect(events.indexOf('req:session/cancel')).toBeLessThan(events.indexOf('stdin-end'));
  });

  it('starts from the launch plan the job recorded', () => {
    const plan = resolveWorkerLaunch({
      job: { launch: { permissionMode: 'auto', model: 'p/m', effort: 'high' }, lane: 'work' },
      globalPermissionMode: 'bypassPermissions',
    });
    const { host, spawn } = harness({
      job: { launch: { permissionMode: 'auto', model: 'p/m', effort: 'high' }, lane: 'work' },
    });
    host.start();

    const args = spawn.mock.calls[0]?.[0]?.args as string[];
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'auto', '--model', 'p/m', '--effort', 'high']));
    expect(plan.lane).toBe('work');
  });
});
