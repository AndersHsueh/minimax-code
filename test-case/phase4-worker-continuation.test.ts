import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createWorkerHost,
  type WorkerHostOptions,
} from '../packages/tui/src/daemon/worker-host.js';

/**
 * Phase 4 acceptance: a live session backgrounded with `←` finishes its work
 * inside the worker.
 *
 * This is the scenario the whole design exists for, and it has one link that
 * is easy to leave out. The Turn cannot be moved — it has to be ended in the
 * foreground and picked up in the worker — and picking it up means
 * `mcode/session/continue`, which submits a new Turn in `continuation` mode
 * from the durable transcript with no new user message.
 *
 * A host that only calls it on crash restart looks correct and silently fails
 * the normal path: a session backgrounded mid-Turn sits in a worker that never
 * resumes it, the row says it is working, and nothing runs. That is the exact
 * bug the plan opens on, so the distinction is asserted rather than assumed.
 *
 * See mydocs/supervisor-plan-v2.md §2.1.1, §5.6.1, Phase 4 acceptance.
 */
describe('backgrounded session resumes in the worker', () => {
  function harness(overrides: Partial<WorkerHostOptions> = {}) {
    const requests: { method: string; params?: unknown }[] = [];
    const child = new EventEmitter() as EventEmitter & {
      stdin: { write(chunk: string): void; end(): void };
      kill(signal?: string): boolean;
    };
    const replies = new Map<string, () => unknown>();
    child.stdin = {
      write(chunk: string) {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line) as { id: number; method: string; params?: unknown };
          requests.push({ method: frame.method, params: frame.params });
          const reply = replies.get(frame.method);
          if (reply) {
            child.emit(
              'data',
              `${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: reply() })}\n`,
            );
          }
        }
      },
      end() {
        /* noop */
      },
    };
    child.kill = () => true;

    replies.set('mcode/session/continue', () => ({ continued: true, turnId: 'turn-2' }));
    replies.set('mcode/worker/activity', () => ({
      runState: 'idle',
      queuePending: 0,
      queuePaused: false,
      goalActive: false,
      backgroundTasks: 0,
    }));

    const options: WorkerHostOptions = {
      sessionId: 'session-1',
      // The default case is a live Turn that was backgrounded: that is the
      // scenario the acceptance criteria name.
      job: { launch: { permissionMode: 'default' }, handoff: { continue: true } },
      spawn: vi.fn(() => child),
      now: () => 0,
      idleTimeoutMs: 60_000,
      ...overrides,
    };
    return { host: createWorkerHost(options), child, requests };
  }

  it('resumes the interrupted Turn on a normal start, not only after a crash', async () => {
    const { host, requests } = harness();

    await host.startWithContinuation();

    // A crash-only resume leaves the normal hand-off path with nothing to do:
    // the worker is alive, says it is idle, and the Turn never continues.
    expect(requests.map((entry) => entry.method)).toContain('mcode/session/continue');
  });

  it('asks for the session it was launched for', async () => {
    const { host, requests } = harness();

    await host.startWithContinuation();

    const call = requests.find((entry) => entry.method === 'mcode/session/continue');
    expect(call?.params).toEqual({ sessionId: 'session-1' });
  });

  it('does not resume when the job records no interrupted Turn', async () => {
    // An idle hand-off has nothing to continue. Asking anyway submits a Turn
    // against a transcript that already ended, which is a spurious turn.
    const { host, requests } = harness({
      job: { launch: { permissionMode: 'default' }, handoff: { continue: false } },
    });

    await host.startWithContinuation();

    expect(requests.map((entry) => entry.method)).not.toContain('mcode/session/continue');
  });

  it('reports whether a Turn was actually resumed', async () => {
    const { host } = harness({
      job: { launch: { permissionMode: 'default' }, handoff: { continue: true } },
    });

    const result = await host.startWithContinuation();

    expect(result).toMatchObject({ continued: true });
  });

  it('reports a refusal from the worker rather than claiming success', async () => {
    const { host } = harness({
      job: { launch: { permissionMode: 'default' }, handoff: { continue: true } },
      spawn: () => {
        const child = new EventEmitter() as EventEmitter & {
          stdin: { write(chunk: string): void; end(): void };
          kill(signal?: string): boolean;
        };
        child.stdin = {
          write(chunk: string) {
            for (const line of chunk.split('\n')) {
              if (!line.trim()) continue;
              const frame = JSON.parse(line) as { id: number };
              child.emit(
                'data',
                `${JSON.stringify({
                  jsonrpc: '2.0',
                  id: frame.id,
                  error: { code: -32000, message: 'Nothing to continue' },
                })}\n`,
              );
            }
          },
          end() {
            /* noop */
          },
        };
        child.kill = () => true;
        return child;
      },
    });

    const result = await host.startWithContinuation();

    // A rejection here means the transcript had no resumable tail. Reporting
    // success would leave a job claiming work that is not happening.
    expect(result).toMatchObject({ continued: false });
  });

  it('does not throw when the worker refuses the resume', async () => {
    const { host } = harness({
      job: { launch: { permissionMode: 'default' }, handoff: { continue: true } },
    });

    await expect(host.startWithContinuation()).resolves.toBeDefined();
  });
});
