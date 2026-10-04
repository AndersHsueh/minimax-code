import { describe, expect, it, vi } from 'vitest';

import {
  TUI_ACP_EXTENSION_METHODS,
  tuiAcpExtensionCapabilities,
  registerTuiAcpExtensions,
} from '../packages/tui/src/acp/extensions.js';
import { TuiConversationAccess } from '../packages/tui/src/runtime/adapters/conversation-access.js';
import { CliService } from '../packages/local-runtime-v2/src/local/cli-service.js';
import type { TuiAcpRuntime } from '../packages/tui/src/acp/runtime.js';

/**
 * Phase 1 contract: `mcode/session/continue` — the only way a background worker
 * can pick up a Turn that a foreground process was cut off mid-flight.
 *
 * Phase 0' measured this: ACP today exposes 14 extension methods and none of them
 * reaches `continueTurn`. `ConversationApplication.inspectTurnContinuation` and
 * `ConversationApplication.continueTurn` have zero callers in the tree, so the
 * capability is implemented and unreachable. Without this method a hand-off can
 * only ever abandon work: the transcript stops at the abort and no process can
 * make the model continue it.
 *
 * The shape matters as much as the existence. A supervisor has to be able to
 * tell "your job is running now" from "there was nothing to continue" from
 * "your job is parked on a permission question", because each one is a different
 * row in the agent view. So the method reports the refusal reason rather than
 * collapsing every non-admission into an error.
 *
 * See mydocs/supervisor-plan-v2.md §2.1.1 (the `mcode/session/continue` step) and
 * Phase 1 acceptance.
 */
describe('mcode/session/continue', () => {
  it('is advertised as an extension method, with and without Goal support', () => {
    expect(TUI_ACP_EXTENSION_METHODS).toContain('mcode/session/continue');
    // Goal being disabled filters only the Goal methods; continuation is unrelated.
    expect(tuiAcpExtensionCapabilities({ isGoalEnabled: () => false }).methods).toContain(
      'mcode/session/continue',
    );
  });

  it('starts a continuation Turn and reports its id', async () => {
    const runtime = acpRuntime({ continueTurnResult: { continued: true, turnId: 'turn-7' } });
    const app = registerExtensions(runtime);

    await expect(callExtension(app, 'mcode/session/continue', { sessionId: 'session-1' })).resolves.toEqual(
      { continued: true, turnId: 'turn-7' },
    );
    expect(runtime.continueTurn).toHaveBeenCalledWith('session-1');
    // Continuation must not be confused with a fresh prompt.
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('reports why a Turn could not be continued instead of failing the call', async () => {
    // The supervisor maps each of these onto a different job state; an opaque
    // error would make "waiting on a permission question" look like a crash.
    for (const reason of ['active-turn', 'unavailable', 'waiting-for-user', 'policy:locked'] as const) {
      const runtime = acpRuntime({ continueTurnResult: { continued: false, reason } });
      const app = registerExtensions(runtime);

      await expect(
        callExtension(app, 'mcode/session/continue', { sessionId: 'session-1' }),
      ).resolves.toEqual({ continued: false, reason });
    }
  });

  it('rejects an unknown Session rather than continuing nothing', async () => {
    const runtime = acpRuntime({ sessions: new Map([['session-1', { sessionId: 'session-1' }]]) });
    const app = registerExtensions(runtime);

    await expect(
      callExtension(app, 'mcode/session/continue', { sessionId: 'session-missing' }),
    ).rejects.toThrow();
    expect(runtime.continueTurn).not.toHaveBeenCalled();
  });

  it('maps the protocol continuation state onto a readable string', async () => {
    // `@mavis/protocol/local` models these as a numeric enum, because they cross a
    // process boundary. A worker protocol should speak names.
    const access = new TuiConversationAccess(cliServiceStub(1) as never);
    await expect(access.inspectTurnContinuation('session-1')).resolves.toBe('available');

    const running = new TuiConversationAccess(cliServiceStub(2) as never);
    await expect(running.inspectTurnContinuation('session-1')).resolves.toBe('running');
  });

  it('exposes continuation through the conversation port and the adapter', async () => {
    // The ACP runtime is an intersection of ports, so a method that is missing from
    // `TuiConversationPort` cannot reach a worker no matter what ACP advertises.
    const service = cliServiceStub(1);
    const access = new TuiConversationAccess(service as never);
    await expect(access.inspectTurnContinuation('session-1')).resolves.toBe('available');
    expect(service.inspectTurnContinuation).toHaveBeenCalledWith({ id: 'session-1' });
  });

  it('routes the port call through CliService to the conversation application', async () => {
    const conversation = {
      startTurnContinuation: vi.fn(async () => ({ accepted: true, turnId: 'turn-9' })),
      inspectTurnContinuation: vi.fn(async () => ({ state: 1 })),
    };
    const service = new CliService({ conversation } as never);

    // CliService keeps the explicit name because the application's own
    // `continueTurn` returns a stream; this one returns an admission.
    await expect(service.startTurnContinuation({ id: 'session-1' })).resolves.toEqual({
      accepted: true,
      turnId: 'turn-9',
    });
    expect(conversation.startTurnContinuation).toHaveBeenCalledWith({}, { id: 'session-1' });
  });
});

/** Protocol `TurnContinuationState` — numeric on the wire, names above. */
function cliServiceStub(state: number) {
  return {
    inspectTurnContinuation: vi.fn(async () => ({ state })),
    continueTurn: vi.fn(async () => ({ accepted: true, turnId: 'turn-7' })),
  };
}

type ContinueTurnResult =
  | { continued: true; turnId: string }
  | { continued: false; reason: string };

function acpRuntime(options: {
  continueTurnResult: ContinueTurnResult;
  sessions?: Map<string, { sessionId: string }>;
}) {
  const sessions = options.sessions ?? new Map([['session-1', { sessionId: 'session-1' }]]);
  return {
    sessions,
    getSession: vi.fn(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`unknown session ${sessionId}`);
      return session;
    }),
    isGoalEnabled: () => true,
    sendMessage: vi.fn(async () => undefined),
    inspectTurnContinuation: vi.fn(async () => ({ state: 'available' })),
    continueTurn: vi.fn(async () => options.continueTurnResult),
  } as unknown as TuiAcpRuntime & {
    sessions: Map<string, { sessionId: string }>;
    getSession: ReturnType<typeof vi.fn>;
    isGoalEnabled: () => boolean;
    sendMessage: ReturnType<typeof vi.fn>;
    inspectTurnContinuation: ReturnType<typeof vi.fn>;
    continueTurn: ReturnType<typeof vi.fn>;
  };
}

function registerExtensions(runtime: ReturnType<typeof acpRuntime>) {
  const handlers = new Map<string, (input: { params: unknown }) => unknown>();
  const app = {
    onRequest: vi.fn(
      (method: string, _parser: unknown, handler: (input: { params: unknown }) => unknown) => {
        handlers.set(method, handler);
      },
    ),
  };
  registerTuiAcpExtensions({
    app: app as never,
    runtime: runtime as never,
    resolveSession: (sessionId) => runtime.sessions.get(sessionId),
    activateSession: () => undefined,
    extensionNotificationsEnabled: () => false,
    activePromptTurnId: () => undefined,
  });
  return { handlers, app };
}

function callExtension(app: { handlers: Map<string, (i: { params: unknown }) => unknown> }, method: string, params: unknown) {
  const handler = app.handlers.get(method);
  if (!handler) throw new Error(`${method} is not registered`);
  return Promise.resolve(handler({ params }));
}
