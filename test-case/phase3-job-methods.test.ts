import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createJobStore } from '../packages/tui/src/daemon/job-store.js';
import { buildAgentsReport, parseSendRequest } from '../packages/tui/src/daemon/agents-cli.js';
import { routeJobMethod, type DaemonJobMethods } from '../packages/tui/src/daemon/job-methods.js';

/**
 * Phase 3 contract: the job methods a client calls, and the `mcode agents` view.
 *
 * Two rules here are safety rules, not interface choices.
 *
 * **`mcode send` cannot answer a permission request.** A background job that
 * needs a decision is parked, and the CLI has no way to show the question in
 * context — approving blind from a one-line command is how a job ends up with
 * `bypassPermissions` by accident. Only an interactive TUI client may reply.
 *
 * **A job with no worker is never started to answer a question.** The process is
 * a cache; `jobs.list` and `mcode agents` read the job files, and asking a
 * jobless job whether it is busy would mean starting one to find out.
 *
 * See mydocs/supervisor-plan-v2.md §3.5, §3.7.1.
 */
describe('daemon job methods', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function store(): Promise<ReturnType<typeof createJobStore>> {
    const dataDir = await mkdtemp(join(tmpdir(), 'daemon-jobs-cli-'));
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
      ...overrides,
    };
  }

  it('lists the jobs it has on disk', async () => {
    const jobs = await store();
    await jobs.writeJob({ proto: 1, sessionId: 'session-1', state: 'idle' });
    await jobs.writeJob({ proto: 1, sessionId: 'session-2', state: 'working' });

    const result = await routeJobMethod(methods(jobs), 'jobs.list', {}, { kind: 'cli' });

    expect(result).toMatchObject({ sessionIds: ['session-1', 'session-2'] });
  });

  it('hides ended jobs unless they are asked for', async () => {
    const jobs = await store();
    await jobs.writeJob({ proto: 1, sessionId: 'session-1', state: 'idle' });
    await jobs.writeJob({ proto: 1, sessionId: 'session-2', state: 'completed' });

    const visible = (await routeJobMethod(methods(jobs), 'jobs.list', {}, { kind: 'cli' })) as {
      sessionIds: string[];
    };
    const all = (await routeJobMethod(
      methods(jobs),
      'jobs.list',
      { includeEnded: true },
      { kind: 'cli' },
    )) as { sessionIds: string[] };

    expect(visible.sessionIds).toEqual(['session-1']);
    expect(all.sessionIds).toEqual(['session-1', 'session-2']);
  });

  it('refuses to reply to an interaction for a non-interactive client', async () => {
    const jobs = await store();
    const reply = vi.fn(async () => ({ rejected: 'rejected' as const }));

    const result = await routeJobMethod(
      methods(jobs, { reply }),
      'job.reply',
      { sessionId: 'session-1', interactionId: 'perm-1', outcome: 'allowOnce' },
      { kind: 'cli' },
    );

    expect(result).toEqual({ rejected: 'not-interactive' });
    expect(reply).not.toHaveBeenCalled();
  });

  it('lets an interactive TUI client reply', async () => {
    const jobs = await store();
    const reply = vi.fn(async () => ({ rejected: 'rejected' as const }));
    const result = await routeJobMethod(
      methods(jobs, { reply }),
      'job.reply',
      { sessionId: 'session-1', interactionId: 'perm-1', outcome: 'deny' },
      { kind: 'tui' },
    );

    expect(result).toEqual({ rejected: 'rejected' });
    expect(reply).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'deny', interactionId: 'perm-1' }),
    );
  });

  it('stages a message for a job that has no worker yet', async () => {
    // Delivery order is the whole point: a crash before the worker is ready must
    // not lose the message, and it must not overtake one already queued.
    const jobs = await store();
    await jobs.writeJob({ proto: 1, sessionId: 'session-1', state: 'idle' });

    await routeJobMethod(
      methods(jobs, {
        send: async () => {
          throw new Error('worker unavailable');
        },
      }),
      'job.send',
      { sessionId: 'session-1', text: 'do the thing', mode: 'queue' },
      { kind: 'cli' },
    );

    const pending = await jobs.listPending('session-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ text: 'do the thing', mode: 'queue' });
  });

  it('treats a message that is exactly /stop as a stop', async () => {
    // Matches Claude Code. A job that is told "/stop" must stop, not queue the
    // literal text and keep running.
    const jobs = await store();
    const stop = async () => ({ stopped: true as const });
    const result = await routeJobMethod(
      methods(jobs, { stop }),
      'job.send',
      { sessionId: 'session-1', text: '/stop', mode: 'queue' },
      { kind: 'cli' },
    );

    expect(result).toEqual({ stopped: true });
  });

  it('removes a job without deleting its transcript', async () => {
    const jobs = await store();
    await jobs.writeJob({ proto: 1, sessionId: 'session-1', state: 'idle' });
    await jobs.appendTimeline('session-1', { at: 1, state: 'idle' });

    const result = await routeJobMethod(
      methods(jobs),
      'job.remove',
      { sessionId: 'session-1' },
      { kind: 'cli' },
    );

    expect(result).toEqual({ removed: true });
    await expect(jobs.readJob('session-1')).resolves.toBeUndefined();
  });

  it('rejects a method it does not implement', async () => {
    const jobs = await store();
    await expect(
      routeJobMethod(methods(jobs), 'job.explode', {}, { kind: 'cli' }),
    ).rejects.toThrow(/job.explode/);
  });
});

describe('mcode agents output', () => {
  it('renders one row per job with its state', () => {
    const text = buildAgentsReport(
      [
        { sessionId: 'session-1', name: 'refactor', state: 'working' },
        { sessionId: 'session-2', name: 'tests', state: 'needs-input' },
      ],
      false,
    );
    expect(text).toMatch(/refactor/);
    expect(text).toMatch(/tests/);
  });

  it('emits machine-readable JSON when asked', () => {
    const text = buildAgentsReport([{ sessionId: 'session-1', name: 'x', state: 'idle' }], true);
    expect(JSON.parse(text)).toEqual([
      { sessionId: 'session-1', name: 'x', state: 'idle' },
    ]);
  });

  it('says so plainly when there is nothing running', () => {
    expect(buildAgentsReport([], false)).toMatch(/no background/i);
  });
});

describe('mcode send parsing', () => {
  it('takes the target and the message in order', () => {
    expect(parseSendRequest(['session-1', 'hello', 'there'])).toEqual({
      sessionId: 'session-1',
      text: 'hello there',
    });
  });

  it('rejects a missing message rather than sending nothing', () => {
    expect(() => parseSendRequest(['session-1'])).toThrow();
  });

  it('rejects a missing target', () => {
    expect(() => parseSendRequest([])).toThrow();
  });
});
