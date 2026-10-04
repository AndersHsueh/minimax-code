import { describe, expect, it, vi } from 'vitest';

import type { AgentHost } from '../packages/local-runtime-v2/src/service/turn-system/agent-host/contracts.js';
import type { ConversationApplicationOptions } from '../packages/local-runtime-v2/src/application/conversation/conversation-application.js';
import { ConversationApplication } from '../packages/local-runtime-v2/src/application/conversation/conversation-application.js';
import {
  createExecutionCoordinator,
  type ExecutionCoordinatorOptions,
} from '../packages/local-runtime-v2/src/service/turn-system/execution/execution.coordinator.js';
import { createSessionOperationGate } from '../packages/local-runtime-v2/src/service/turn-system/lifecycle/session-operation-gate.js';
import {
  createTurnExecutionService,
  type TurnExecutionServiceOptions,
} from '../packages/local-runtime-v2/src/service/turn-system/execution/turn-execution.service.js';
import type {
  AcceptedAgentTurn,
  TurnController,
  TurnFailureProjection,
  TurnPreparationProjection,
  TurnRepository,
} from '../packages/local-runtime-v2/src/service/turn-system/execution/contracts.js';

/**
 * Phase 1 contract: what a `background_handoff` abort actually does to durable
 * state — as opposed to what its name suggests it does.
 *
 * Handing a foreground session to a background worker aborts the live Turn. Three
 * things must then be true, and each one lives behind a separate decision:
 *
 *  1. `local_runtime_queue_pauses` gains NO row
 *     (`execution.coordinator.ts` → `terminalQueuePauseCause` → `pausesQueueOnAbort`)
 *  2. the session's Goal is NOT paused
 *     (`conversation-application.ts` `abortSession` → `pauseActiveGoalForAbort`)
 *  3. background work is NOT cascaded
 *     (`turn-execution.service.ts` → `beginUserStopCascade`)
 *
 * The failure this guards: the hand-off reuses the `session_leave` shape almost
 * exactly, so the tempting implementation is to reuse the *reason* too. That
 * pauses the queue, and a durably paused queue never drains again — so every
 * message the supervisor later delivers to a backgrounded session would sit
 * there forever while the job reports "running". Phase 0' measured the same trap
 * for SIGTERM shutdown (leftover `queued` items re-firing on the next start).
 *
 * These drive the real production objects with structural fakes, so a future
 * refactor that moves a decision cannot silently change the effect.
 *
 * See mydocs/supervisor-plan-v2.md §2.1 step 4 and §六 护栏清单.
 */
describe('background_handoff has no durable side effects', () => {
  it('settles an aborted product Turn with no queue pause', async () => {
    const harness = coordinatorHarness();
    harness.host.run.mockResolvedValueOnce({ status: 'aborted', reason: 'handed off' });

    const started = await harness.coordinator.startTurn({
      turn: agentTurn('background_handoff'),
      request: {
        input: { text: 'keep working' },
        genuineUserQueryText: 'keep working',
        provenance: { source: 'api', routingFingerprint: 'api:background-handoff' },
      },
    });
    await started.completion;

    // An absent `queuePauseCause` is what keeps `local_runtime_queue_pauses` empty,
    // so assert on the value rather than on the key being present.
    expect(queuePauseCauses(harness)).toEqual([undefined]);
  });

  it('still pauses the queue for the two reasons that mean "I stopped watching"', async () => {
    // The control: `background_handoff` is only safe because these two still work.
    for (const reason of ['user_stop', 'session_leave']) {
      const harness = coordinatorHarness();
      harness.host.run.mockResolvedValueOnce({ status: 'aborted', reason: 'stopped' });

      const started = await harness.coordinator.startTurn({
        turn: agentTurn(reason),
        request: {
          input: { text: 'stop' },
          genuineUserQueryText: 'stop',
          provenance: { source: 'api', routingFingerprint: `api:${reason}` },
        },
      });
      await started.completion;

      expect(queuePauseCauses(harness)).toEqual(['user-stop']);
    }
  });

  it('does not pause the session Goal', async () => {
    const harness = conversationHarness();

    const result = await harness.conversation.abortSession(
      {},
      { id: 'session-1', reason: 'background_handoff' },
    );

    expect(result).toEqual({ success: true });
    expect(harness.pauseActiveForAbort).not.toHaveBeenCalled();
  });

  it('still pauses the Goal for the reasons that pause the queue', async () => {
    // The Goal must keep following the queue, or a resumed session would report an
    // active Goal that nothing is driving.
    for (const reason of ['user_stop', 'session_leave']) {
      const harness = conversationHarness();

      await harness.conversation.abortSession({}, { id: 'session-1', reason });

      expect(harness.pauseActiveForAbort).toHaveBeenCalledWith('session-1');
    }
  });

  it('does not cascade into the session background work', async () => {
    const harness = turnExecutionHarness();

    await harness.service.abort({ sessionId: 'session-1', reason: 'background_handoff' });

    expect(harness.cascadeBegin).not.toHaveBeenCalled();
    // The Turn really was stopped — a hand-off is an abort, not a no-op.
    expect(harness.controller.abort).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', reason: 'background_handoff' }),
    );
  });
});

function coordinatorHarness(overrides: Partial<ExecutionCoordinatorOptions> = {}) {
  const host = {
    run: vi.fn<AgentHost['run']>(async () => ({ status: 'completed' })),
    compact: vi.fn<AgentHost['compact']>(async () => ({
      status: 'unchanged',
      reason: 'nothing-to-compact',
    })),
  } as unknown as AgentHost;
  const repository = {
    settle: vi.fn<TurnRepository['settle']>(async ({ outcome }) => ({
      status: 'settled' as const,
      completedAtMs: 100,
      outcome,
    })),
  };
  const controller = { complete: vi.fn<TurnController['complete']>() };
  const failures = {
    project: vi.fn<TurnFailureProjection['project']>(async () => undefined),
  };
  const preparation = {
    projectStarted: vi.fn<TurnPreparationProjection['projectStarted']>(async () => undefined),
  };
  const released = { publish: vi.fn(async () => undefined) };
  const turnSettlement = { settle: vi.fn(async () => undefined), abandon: vi.fn(async () => undefined) };
  const coordinator = createExecutionCoordinator({
    onBeginSettlement: vi.fn(),
    host,
    repository,
    controller,
    preparation,
    failures,
    released,
    turnSettlement,
    ...overrides,
  });
  return { host, repository, controller, coordinator };
}

function admission() {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    leaseId: 'lease-1',
    acceptedSequence: 1,
    acceptedAtMs: 50,
    busyReason: 'turn' as const,
    foreground: true as const,
  };
}

function agentTurn(abortReason?: string): AcceptedAgentTurn {
  const controller = new AbortController();
  if (abortReason) controller.abort(abortReason);
  return { ...admission(), signal: controller.signal } as AcceptedAgentTurn;
}

function conversationHarness() {
  const pauseActiveForAbort = vi.fn(async () => undefined);
  // The Goal is paused through the `onAccepted` seam the application hands to the
  // Turn service, so the fake has to honour it the way the real service does.
  const abort = vi.fn(async (input: { readonly onAccepted?: () => Promise<void> | void }) => {
    await input.onAccepted?.();
    return { status: 'aborted' as const, turnId: 'turn-1' };
  });
  const options = {
    turn: { abort },
    sessionReader: { find: async () => ({ agentName: 'mavis', status: 'idle' }) },
    threadGoal: { pauseActiveForAbort },
  } as unknown as ConversationApplicationOptions;
  return { conversation: new ConversationApplication(options), abort, pauseActiveForAbort };
}

function turnExecutionHarness() {
  const cascadeBegin = vi.fn(async () => ({
    accept: vi.fn(async () => undefined),
    complete: vi.fn(),
    cancel: vi.fn(),
  }));
  const controller = {
    register: vi.fn(() => ({
      sessionId: 'session-1',
      turnId: 'turn-1',
      leaseId: 'lease-1',
      acceptedSequence: 1,
      acceptedAtMs: 100,
      busyReason: 'turn' as const,
      signal: new AbortController().signal,
    })),
    abort: vi.fn<TurnController['abort']>(async () => ({ status: 'aborted', turnId: 'turn-1' })),
    steerActiveTurn: vi.fn<TurnController['steerActiveTurn']>(async () => ({ status: 'not-running' })),
    steerToolResultTail: vi.fn<TurnController['steerToolResultTail']>(async () => ({
      status: 'not-running',
    })),
    beginClose: vi.fn<TurnController['beginClose']>(() => ({ closed: true })),
    complete: vi.fn<TurnController['complete']>(),
    activeTurnId: vi.fn<TurnController['activeTurnId']>(() => 'turn-1'),
    close: vi.fn<TurnController['close']>(async () => undefined),
  };
  const options = {
    repository: idleRepository(),
    controller,
    coordinator: {
      startTurn: vi.fn(async () => ({
        completion: Promise.resolve({ status: 'completed' as const }),
      })),
      failTurn: vi.fn(async ({ error }: { error: Error }) => ({
        completion: Promise.resolve({ status: 'failed' as const, error }),
      })),
      failAdmission: vi.fn(async ({ error }: { error: Error }) => ({
        completion: Promise.resolve({ status: 'failed' as const, error }),
      })),
      compact: vi.fn(async () => ({ status: 'unchanged' as const, reason: 'nothing-to-compact' as const })),
    },
    operations: createSessionOperationGate(),
    onInterruptSendReleased: vi.fn(async () => undefined),
    sessions: { has: vi.fn(async () => true) },
    submissionPreparation: {
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      compensate: vi.fn(async () => undefined),
      prepare: vi.fn(async () => ({ status: 'ready' as const })),
    },
    preparation: { projectStarted: vi.fn(async () => undefined) },
    failures: { project: vi.fn(async () => undefined) },
    nowMs: () => 1,
    makeTurnId: () => 'turn-1',
    userStop: { begin: cascadeBegin },
  } as unknown as TurnExecutionServiceOptions;
  return { service: createTurnExecutionService(options), controller, cascadeBegin };
}

/** An idle repository: no admission, no maintenance, nothing to settle. */
function idleRepository() {
  const noMaintenance = async () => undefined;
  return {
    tryAcquireSessionMaintenance: vi.fn(noMaintenance),
    renewSessionMaintenance: vi.fn(async () => true),
    releaseSessionMaintenance: vi.fn(noMaintenance),
    admit: vi.fn(async () => ({
      status: 'accepted' as const,
      leaseId: 'lease-1',
      acceptedSequence: 1,
      acceptedAtMs: 100,
    })),
    renew: vi.fn(async () => true),
    settle: vi.fn(async () => ({ status: 'settled' as const, completedAtMs: 1 })),
    recoverExpired: vi.fn(async () => ({ released: false, terminalFacts: [] })),
    recoverProcessRestart: vi.fn(async () => ({ recovered: [], terminalFacts: [] })),
    findActiveTurn: vi.fn(async () => undefined),
    findLatestTurnActivity: vi.fn(async () => undefined),
    preparePluginHookSessionOwnership: vi.fn(noMaintenance),
    activatePluginHookSessionOwnership: vi.fn(noMaintenance),
    findLatestPluginHookSessionOwnership: vi.fn(async () => undefined),
    tryClaimPluginHookSessionEnd: vi.fn(async () => ({ status: 'claimed' as const })),
    completePluginHookSessionEnd: vi.fn(async () => true),
    findReceipt: vi.fn(async () => undefined),
    findSteeringReceipt: vi.fn(async () => undefined),
    reserveSteeringReceipt: vi.fn(async () => ({ status: 'not-accepted' as const })),
    releaseSteeringReceipt: vi.fn(noMaintenance),
    revokeAdmission: vi.fn(async () => true),
    beginSessionDeletion: vi.fn(async () => ({ status: 'quiescent' as const })),
    readSessionDeletion: vi.fn(async () => ({ status: 'not-started' as const })),
    isSessionDeleting: vi.fn(async () => false),
    deleteSessionData: vi.fn(noMaintenance),
    completeSessionDeletion: vi.fn(noMaintenance),
    isAcceptedInTransaction: vi.fn(() => true),
    markAcknowledgedInTransaction: vi.fn(),
  };
}

function queuePauseCauses(harness: { repository: { settle: { mock: { calls: unknown[][] } } } }) {
  return harness.repository.settle.mock.calls.map(([input]) => input.queuePauseCause);
}
