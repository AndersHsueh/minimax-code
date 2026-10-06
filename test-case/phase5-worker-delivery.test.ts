import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createWorkerHost, type WorkerHostOptions } from '../packages/tui/src/daemon/worker-host.js';

/**
 * Worker delivery: what has to be true for a message to reach a session and for
 * that session's answer to come back.
 *
 * The `phase3-worker-host` suite drives a fake that emits `'data'` on the
 * process object. That shape is precisely why delivery stayed broken while
 * every test passed: a real `child_process` never emits `'data'` — piped stdout
 * arrives on `child.stdout` — so a host written against the fake reads nothing
 * from an actual worker. Every fake here exposes `stdout` as a real stream, the
 * way `spawn()` does, and asserts the host reads from it.
 */
describe('worker delivery', () => {
  /** A scripted reply, or an error the worker refuses the request with. */
  type Script = (params: unknown) => unknown | Promise<unknown> | { readonly __error: string };

  function harness(overrides: Partial<WorkerHostOptions> = {}) {
    const requests: { method: string; params?: unknown }[] = [];
    const replies = new Map<string, Script>();

    // stdout and stderr are streams; the process emits only lifecycle events,
    // exactly as `child_process` does.
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as EventEmitter & {
      stdin: { write(chunk: string): void; end(): void };
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill(signal?: string): boolean;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = () => true;

    child.stdin = {
      write(chunk: string) {
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line) as { id: number; method: string; params?: unknown };
          requests.push({ method: frame.method, params: frame.params });
          const scripted = replies.get(frame.method);
          if (scripted === undefined) continue;
          Promise.resolve(scripted(frame.params)).then((outcome) => {
            const body =
              outcome && typeof outcome === 'object' && '__error' in outcome
                ? { jsonrpc: '2.0', id: frame.id, error: { code: -32002, message: outcome.__error } }
                : { jsonrpc: '2.0', id: frame.id, result: outcome };
            stdout.emit('data', `${JSON.stringify(body)}\n`);
          });
        }
      },
      end: () => undefined,
    };

    replies.set('initialize', () => ({ protocolVersion: 1, agentCapabilities: {} }));
    replies.set('session/load', () => ({ modes: {} }));
    replies.set('session/prompt', () => ({ stopReason: 'end_turn' }));
    replies.set('mcode/worker/activity', () => ({
      runState: 'idle',
      queuePending: 0,
      queuePaused: false,
      goalActive: false,
      backgroundTasks: 0,
    }));

    const host = createWorkerHost({
      sessionId: 'session-1',
      job: { launch: { permissionMode: 'default' } },
      cwd: '/tmp',
      spawn: vi.fn(() => child),
      now: () => 0,
      idleTimeoutMs: 10 * 60_000,
      ...overrides,
    });
    return { host, child, stdout, stderr, requests, replies };
  }

  it('loads the session on stdout before it prompts it', async () => {
    const { host, requests } = harness();
    host.start();
    void host.send({ text: 'hello', mode: 'queue' });

    await vi.waitFor(() => expect(requests.map((r) => r.method)).toContain('session/prompt'));
    const methods = requests.map((r) => r.method);
    // Handshake, then the session, then the prompt. Prompting an id the worker
    // has not loaded is refused with `Resource not found` and no Turn ever runs.
    expect(methods).toContain('initialize');
    expect(methods.indexOf('initialize')).toBeLessThan(methods.indexOf('session/load'));
    expect(methods.indexOf('session/load')).toBeLessThan(methods.indexOf('session/prompt'));
  });

  it('records the reply the worker streamed back', async () => {
    const { host, stdout, requests, replies } = harness();
    // The answer arrives as `session/update` chunks, not in the prompt's result.
    replies.set('session/prompt', (params) => {
      stdout.emit(
        'data',
        `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: (params as { sessionId?: string }).sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
          },
        })}\n`,
      );
      return { stopReason: 'end_turn' };
    });
    host.start();
    void host.send({ text: 'hello', mode: 'queue' });

    await vi.waitFor(async () => {
      const events = (await host.peek()) as ReadonlyArray<{ kind?: string; text?: string }>;
      expect(events.some((e) => e.kind === 'turn-finished' && e.text === 'done')).toBe(true);
    });
    expect(requests.map((r) => r.method)).toContain('session/prompt');
  });

  it('rejects when the worker answers a request with a JSON-RPC error', async () => {
    const { host, replies, requests } = harness();
    // A session that cannot be loaded is refused, not answered with `undefined`.
    replies.set('session/load', () => ({ __error: 'Resource not found' }));
    host.start();
    void host.send({ text: 'x', mode: 'queue' });

    await vi.waitFor(async () => {
      const events = (await host.peek()) as ReadonlyArray<{ kind?: string; text?: string }>;
      expect(events.some((e) => e.kind === 'turn-failed')).toBe(true);
    });
    // The prompt must never be sent to a session that failed to load.
    expect(requests.map((r) => r.method)).not.toContain('session/prompt');
  });

  it('rejects in-flight requests when the worker exits', async () => {
    const { host, child, replies } = harness();
    replies.set('session/load', () => new Promise<never>(() => undefined)); // never answers
    host.start();
    // `send` answers about delivery, not about the Turn, so it returns at once.
    await expect(host.send({ text: 'x', mode: 'queue' })).resolves.toMatchObject({
      delivered: true,
    });
    await vi.waitFor(() => expect(child.listenerCount('exit')).toBeGreaterThan(0));

    child.emit('exit', 1, null);
    // The Turn cannot still be waiting on a process that is gone: the outcome is
    // reported instead of leaving the caller pending forever.
    await vi.waitFor(async () => {
      const events = (await host.peek()) as ReadonlyArray<{ kind?: string }>;
      expect(events.some((e) => e.kind === 'turn-failed' || e.kind === 'turn-finished')).toBe(true);
    });
  });
});
