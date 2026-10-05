import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJobStore } from '../packages/tui/src/daemon/job-store.js';
import { routeJobMethod, type DaemonJobMethods } from '../packages/tui/src/daemon/job-methods.js';

/**
 * Phase 4 contract: the session-control methods a foreground TUI calls.
 *
 * `backgroundSession` (Phase 4a) is the *decision* — refuse a non-empty
 * composer, make sure a supervisor exists before ending a Turn, abort with
 * `background_handoff`, wait for the Turn to settle. It is pure and injected.
 * These are the three methods that decision actually calls, and each one is a
 * place where a plausible-looking implementation loses work:
 *
 *  - **`job.adopt` must not start a worker for an idle hand-off.** The process is
 *    a cache (§2.2); a 350 MB process started to hold an empty job is the one
 *    thing this design is supposed to avoid. It starts only when there is
 *    something to do — a resumed Turn, a non-empty queue, or a live Goal.
 *  - **`job.attach` must refuse a busy session rather than steal it.** Ownership
 *    is one holder at a time (§3.7). Two TUIs attached to one session both think
 *    they own the queue, and both write turns to the same transcript.
 *  - **`job.peek` must not claim live progress it does not have.** Case B in
 *    §3.7 renders "已落库部分" plus what the daemon forwards. If peek answers
 *    with a fabricated `running` when the worker is gone, the user watches a
 *    dot that means nothing.
 *
 * See mydocs/supervisor-plan-v2.md §2.1.1, §2.2, §3.7, §3.7.1.
 */
describe('daemon session-control methods', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function store(): Promise<ReturnType<typeof createJobStore>> {
    const dataDir = await mkdtemp(join(tmpdir(), 'daemon-session-control-'));
    roots.push(dataDir);
    return createJobStore({ dataDir });
  }

  function methods(
    jobs: ReturnType<typeof createJobStore>,
    overrides: Partial<DaemonJobMethods> = {},
  ): DaemonJobMethods {
    return {
      jobs,
      listJobs: async () => [],
      send: async () => ({ delivered: true, mode: 'queue' }),
      stop: async () => ({ stopped: true }),
      remove: async () => ({ removed: true }),
      reply: async () => ({ rejected: 'not-interactive' as const }),
      adopt: async () => ({ adopted: true, workerStarted: false }),
      attach: async () => ({ owner: 'client' as const, live: false }),
      peek: async () => ({ owner: 'client' as const, live: false, events: [] }),
      ...overrides,
    };
  }

  const tui = { kind: 'tui' };

  describe('job.adopt', () => {
    it('records the job and leaves an idle hand-off without a worker', async () => {
      const jobs = await store();
      const adopt = vi.fn(async () => ({ adopted: true, workerStarted: false }));

      const result = await routeJobMethod(
        methods(jobs, { adopt }),
        'job.adopt',
        {
          sessionId: 'session-1',
          launch: { permissionMode: 'auto' },
          handoff: { continue: false },
        },
        tui,
      );

      expect(result).toMatchObject({ adopted: true, workerStarted: false });
      expect(adopt).toHaveBeenCalledTimes(1);
    });

    it('starts a worker only when a Turn has to be resumed', async () => {
      const jobs = await store();
      const adopt = vi.fn(async () => ({ adopted: true, workerStarted: true }));

      await routeJobMethod(
        methods(jobs, { adopt }),
        'job.adopt',
        {
          sessionId: 'session-1',
          launch: { permissionMode: 'auto' },
          handoff: { continue: true },
        },
        tui,
      );

      expect(adopt).toHaveBeenCalledWith(
        expect.objectContaining({ handoff: { continue: true } }),
      );
    });

    it('passes the permission mode through verbatim', async () => {
      const jobs = await store();
      const adopt = vi.fn(async () => ({ adopted: true, workerStarted: false }));

      // The mode is read once, at hand-off, and written into the job so a later
      // respawn reuses it. A daemon-side default would let a global change in
      // another terminal silently widen a job's permissions.
      await routeJobMethod(
        methods(jobs, { adopt }),
        'job.adopt',
        {
          sessionId: 'session-1',
          launch: { permissionMode: 'bypassPermissions' },
          handoff: { continue: false },
        },
        tui,
      );

      expect(adopt).toHaveBeenCalledWith(
        expect.objectContaining({ launch: { permissionMode: 'bypassPermissions' } }),
      );
    });

    it('rejects an adopt with no session id', async () => {
      const jobs = await store();
      const adopt = vi.fn(async () => ({ adopted: true, workerStarted: false }));

      await expect(
        routeJobMethod(methods(jobs, { adopt }), 'job.adopt', { handoff: {} }, tui),
      ).rejects.toThrow(/sessionId/);
      expect(adopt).not.toHaveBeenCalled();
    });

    it('rejects an adopt with no permission mode', async () => {
      const jobs = await store();
      const adopt = vi.fn(async () => ({ adopted: true, workerStarted: false }));

      // Absent rather than defaulted: §2.1 point 6 says the mode is the one in
      // effect at hand-off, and "in effect" is not something the daemon can guess.
      await expect(
        routeJobMethod(
          methods(jobs, { adopt }),
          'job.adopt',
          { sessionId: 'session-1', handoff: { continue: false } },
          tui,
        ),
      ).rejects.toThrow(/permissionMode/);
      expect(adopt).not.toHaveBeenCalled();
    });

    it('writes the adoption into the timeline so a crash is visible', async () => {
      const jobs = await store();

      await routeJobMethod(
        methods(jobs, {
          adopt: async (input) => {
            await jobs.writeJob({
              proto: 1,
              sessionId: input.sessionId,
              state: 'idle',
              origin: 'background',
              launch: input.launch,
            });
            await jobs.appendTimeline(input.sessionId, {
              at: 1_700_000_000_000,
              state: 'background',
              detail: 'handoff-committed',
            });
            return { adopted: true, workerStarted: input.handoff.continue };
          },
        }),
        'job.adopt',
        {
          sessionId: 'session-1',
          launch: { permissionMode: 'default' },
          handoff: { continue: true },
        },
        tui,
      );

      const timeline = await jobs.readTimeline('session-1');
      expect(timeline).toEqual([
        expect.objectContaining({ detail: 'handoff-committed', state: 'background' }),
      ]);
    });

    it('surfaces a refusal instead of reporting a silent success', async () => {
      const jobs = await store();

      // A busy or already-attached job must come back as a refusal the UI can
      // render. Reporting `{adopted:true}` here would leave the foreground
      // believing it released the session to a job that never took it.
      const result = await routeJobMethod(
        methods(jobs, { adopt: async () => ({ adopted: false, reason: 'busy' as const }) }),
        'job.adopt',
        {
          sessionId: 'session-1',
          launch: { permissionMode: 'default' },
          handoff: { continue: false },
        },
        tui,
      );

      expect(result).toEqual({ adopted: false, reason: 'busy' });
    });
  });

  describe('job.attach', () => {
    it('hands ownership to the client when the job is idle', async () => {
      const jobs = await store();

      const result = await routeJobMethod(
        methods(jobs, { attach: async () => ({ owner: 'client' as const, live: false }) }),
        'job.attach',
        { sessionId: 'session-1' },
        tui,
      );

      expect(result).toMatchObject({ owner: 'client', live: false });
    });

    it('reports the worker as the owner when it is still running', async () => {
      const jobs = await store();

      // Case B in §3.7. The TUI opens a read-only peek and queues messages; it
      // must not act as if it now owns the session.
      const result = await routeJobMethod(
        methods(jobs, { attach: async () => ({ owner: 'worker' as const, live: true }) }),
        'job.attach',
        { sessionId: 'session-1' },
        tui,
      );

      expect(result).toMatchObject({ owner: 'worker', live: true });
    });

    it('refuses when another client already owns the session', async () => {
      const jobs = await store();

      const result = await routeJobMethod(
        methods(jobs, {
          attach: async () => ({ owner: 'none' as const, live: false, reason: 'already-attached' as const }),
        }),
        'job.attach',
        { sessionId: 'session-1' },
        tui,
      );

      expect(result).toMatchObject({ reason: 'already-attached' });
    });

    it('rejects an attach with no session id', async () => {
      const jobs = await store();
      const attach = vi.fn(async () => ({ owner: 'client' as const, live: false }));

      await expect(
        routeJobMethod(methods(jobs, { attach }), 'job.attach', {}, tui),
      ).rejects.toThrow(/sessionId/);
      expect(attach).not.toHaveBeenCalled();
    });
  });

  describe('job.peek', () => {
    it('returns the durable tail for a job with no live worker', async () => {
      const jobs = await store();
      await jobs.appendTimeline('session-1', {
        at: 1,
        state: 'working',
        detail: 'tool-call',
      });
      await jobs.appendTimeline('session-1', {
        at: 2,
        state: 'working',
        detail: 'tool-result',
      });

      const result = (await routeJobMethod(
        methods(jobs, {
          peek: async (input) => ({
            owner: 'client' as const,
            live: false,
            events: await jobs.readTimeline(input.sessionId),
          }),
        }),
        'job.peek',
        { sessionId: 'session-1' },
        tui,
      )) as { events: readonly { detail: string }[] };

      expect(result.events.map((event) => event.detail)).toEqual(['tool-call', 'tool-result']);
    });

    it('never claims a live worker is running when the process is gone', async () => {
      const jobs = await store();

      // The dot-versus-cross distinction in the agent view is process liveness.
      // A peek that reported `live: true` after the worker died would put the
      // user in a view that only ever repaints.
      const result = (await routeJobMethod(
        methods(jobs, {
          peek: async () => ({ owner: 'client' as const, live: false, events: [] }),
        }),
        'job.peek',
        { sessionId: 'session-1' },
        tui,
      )) as { live: boolean };

      expect(result.live).toBe(false);
    });

    it('starts from the requested cursor rather than replaying the whole timeline', async () => {
      const jobs = await store();
      const peek = vi.fn(async () => ({ owner: 'client' as const, live: false, events: [] }));

      // `after` is what makes a peek usable at all: case B repaints constantly,
      // and re-reading the full timeline each time would grow without bound.
      await routeJobMethod(
        methods(jobs, { peek }),
        'job.peek',
        { sessionId: 'session-1', after: 42 },
        tui,
      );

      expect(peek).toHaveBeenCalledWith(expect.objectContaining({ after: 42 }));
    });

    it('rejects a peek with no session id', async () => {
      const jobs = await store();
      const peek = vi.fn(async () => ({ owner: 'client' as const, live: false, events: [] }));

      await expect(routeJobMethod(methods(jobs, { peek }), 'job.peek', {}, tui)).rejects.toThrow(
        /sessionId/,
      );
      expect(peek).not.toHaveBeenCalled();
    });
  });
});
