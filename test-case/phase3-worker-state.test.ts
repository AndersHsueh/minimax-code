import { describe, expect, it } from 'vitest';

import {
  deriveJobState,
  isWorkerReclaimable,
  type WorkerActivity,
  type WorkerObservation,
} from '../packages/tui/src/daemon/worker-state.js';
import { createAwakeClock, type AwakeClock } from '../packages/tui/src/daemon/awake-clock.js';

/**
 * Phase 3 contract: deciding whether a background worker is busy.
 *
 * This is the decision that costs money and annoys people, and it fails in both
 * directions. Reclaim a worker that is still working and the job dies mid-turn
 * with no worker to resume it. Never reclaim one and the user accumulates
 * processes for sessions that finished hours ago.
 *
 * "No active turn" is not a sufficient test, for reasons that are not obvious
 * until they bite:
 *
 *  - a **paused queue with pending items** is idle right up until the user
 *    unpauses it, and then the dispatcher starts a turn with no worker there
 *  - an **active Goal** starts turns on its own
 *  - **background bash** is owned by the process that started it; killing the
 *    process does not stop the bash, it orphans it, and its completion wakes the
 *    session into a turn nobody is driving
 *  - a **pending permission request lives only in process memory**, so a worker
 *    stopped while holding one loses the request the user was about to answer
 *
 * The activity payload is deliberately the worker's own answer rather than a
 * database read: the daemon does not embed the runtime, and a job with no worker
 * must never be started just to ask whether it is busy.
 *
 * See mydocs/supervisor-plan-v2.md §2.3 and §3.3.
 */
describe('worker activity', () => {
  const idle: WorkerActivity = {
    runState: 'idle',
    queuePending: 0,
    queuePaused: false,
    goalActive: false,
    backgroundTasks: 0,
  };

  function observation(overrides: Partial<WorkerObservation> = {}): WorkerObservation {
    return {
      workerAlive: true,
      promptInFlight: false,
      pendingInteractions: 0,
      watchedByClients: 0,
      activity: idle,
      ...overrides,
    };
  }

  describe('reclaim', () => {
    it('reclaims a worker with nothing going on', () => {
      expect(isWorkerReclaimable(observation())).toBe(true);
    });

    it('keeps a worker that is mid-prompt', () => {
      expect(isWorkerReclaimable(observation({ promptInFlight: true }))).toBe(false);
    });

    it('keeps a worker holding an unanswered permission request', () => {
      // The request exists only in the worker's memory. Stopping here loses it,
      // and the user is left looking at a job that stopped asking.
      expect(isWorkerReclaimable(observation({ pendingInteractions: 1 }))).toBe(false);
    });

    it('keeps a worker whose queue will dispatch on its own', () => {
      const busy = observation({ activity: { ...idle, queuePending: 2, queuePaused: false } });
      expect(isWorkerReclaimable(busy)).toBe(false);
    });

    it('reclaims a worker with a paused queue even when it has items', () => {
      // A paused queue cannot dispatch anything on its own. This is the one case
      // where "pending items" is not a reason to keep the process alive.
      const paused = observation({ activity: { ...idle, queuePending: 2, queuePaused: true } });
      expect(isWorkerReclaimable(paused)).toBe(true);
    });

    it('keeps a worker with an active Goal', () => {
      const withGoal = observation({ activity: { ...idle, goalActive: true } });
      expect(isWorkerReclaimable(withGoal)).toBe(false);
    });

    it('keeps a worker that owns a running background task', () => {
      const withBash = observation({ activity: { ...idle, backgroundTasks: 1 } });
      expect(isWorkerReclaimable(withBash)).toBe(false);
    });

    it('keeps a worker somebody is watching', () => {
      expect(isWorkerReclaimable(observation({ watchedByClients: 1 }))).toBe(false);
    });

    it('keeps a worker that is not alive, because there is nothing to reclaim', () => {
      // Reclaim means "stop this process". A dead process is not reclaimable; it
      // is already gone, and treating the two the same hides a crash.
      expect(isWorkerReclaimable(observation({ workerAlive: false }))).toBe(false);
    });

    it('needs every condition at once, not any one of them', () => {
      const everythingElseIdle: WorkerObservation = observation({
        activity: { ...idle, queuePending: 3, goalActive: true, backgroundTasks: 1 },
        promptInFlight: true,
        pendingInteractions: 2,
        watchedByClients: 1,
      });
      expect(isWorkerReclaimable(everythingElseIdle)).toBe(false);
    });

    it('treats a paused queue as a reportable state rather than a silent one', () => {
      // The user stopped this session earlier. Silently clearing that pause when
      // the job is backgrounded would discard their decision.
      const paused = observation({ activity: { ...idle, queuePending: 1, queuePaused: true } });
      expect(deriveJobState(paused, 'idle').flags).toContain('queue-paused');
    });
  });

  describe('job state', () => {
    it('calls a working job Working', () => {
      const state = deriveJobState(observation({ promptInFlight: true }), 'idle');
      expect(state.state).toBe('working');
    });

    it('calls a job waiting on a permission request Needs input', () => {
      const state = deriveJobState(observation({ pendingInteractions: 1 }), 'idle');
      expect(state.state).toBe('needs-input');
    });

    it('prefers Needs input over Working when both are somehow true', () => {
      // A turn that is in flight but has raised a question is not "working" from
      // the user's point of view: nothing will happen until they answer.
      const state = deriveJobState(
        observation({ promptInFlight: true, pendingInteractions: 1 }),
        'idle',
      );
      expect(state.state).toBe('needs-input');
    });

    it('calls a live worker with nothing to do Idle', () => {
      expect(deriveJobState(observation(), 'idle').state).toBe('idle');
    });

    it('reports a live worker that is mid-turn as Working, not by its activity alone', () => {
      // `runState` is the runtime's view; the in-flight prompt is the daemon's.
      // They can disagree for a moment and the prompt is the one that matters.
      const state = deriveJobState(
        observation({ promptInFlight: true, activity: { ...idle, runState: 'running' } }),
        'idle',
      );
      expect(state.state).toBe('working');
    });

    it('does not invent activity for a job with no worker', () => {
      // Asking a jobless job whether it is busy would mean starting a worker to
      // find out, which is exactly what "the process is a cache" forbids.
      const state = deriveJobState(observation({ workerAlive: false }), 'completed');
      expect(state.state).toBe('completed');
    });

    it('reports a live worker running a Turn as Working even after an earlier failure', () => {
      // A crash past the restart limit records `failed`; the next worker is a
      // different process doing different work. Showing the stale verdict would
      // hide that something is running right now.
      expect(deriveJobState(observation({ promptInFlight: true }), 'failed').state).toBe('working');
    });

    it('keeps a terminal verdict while the job sits idle with no worker', () => {
      // Nothing is running, so the last outcome is the most useful thing to show.
      expect(deriveJobState(observation({ workerAlive: false }), 'failed').state).toBe('failed');
    });

    it('distinguishes a user stop from a failure', () => {
      // Both end the work, but only one was asked for. The icon differs.
      expect(deriveJobState(observation({ workerAlive: false }), 'stopped').state).toBe('stopped');
      expect(deriveJobState(observation({ workerAlive: false }), 'failed').state).toBe('failed');
    });
  });

  describe('awake clock', () => {
    it('reports no sleep when wall time tracks the monotonic clock', () => {
      const clock = fakeClock([
        [30_000, 30_000],
        [30_000, 30_000],
      ]);
      clock.tick();
      clock.tick();
      expect(clock.lastTickSlept).toBe(false);
    });

    it('reports a sleep when wall time jumps an hour ahead of a still clock', () => {
      // A laptop that was closed for an hour must not count that hour as idle,
      // or every worker would look long-idle the moment it wakes.
      const clock = fakeClock([
        [1_000, 1_000],
        [1_000, 3_600_000],
      ]);
      clock.tick();
      clock.tick();
      expect(clock.lastTickSlept).toBe(true);
    });

    it('tolerates ordinary scheduling jitter', () => {
      const clock = fakeClock([
        [30_000, 30_000],
        [30_100, 30_400],
      ]);
      clock.tick();
      clock.tick();
      expect(clock.lastTickSlept).toBe(false);
    });

    it('accumulates awake time only across awake gaps', () => {
      const awake = fakeClock([
        [60_000, 60_000],
        [60_000, 60_000],
      ]);
      awake.tick();
      awake.tick();
      expect(awake.awakeMsSince(0)).toBe(120_000);

      const slept = fakeClock([
        [60_000, 60_000],
        [0, 3_600_000],
      ]);
      slept.tick();
      slept.tick();
      // The sleeping hour contributes nothing.
      expect(slept.awakeMsSince(0)).toBe(60_000);
    });

    it('measures an idle window from a baseline taken after the sleep', () => {
      const clock = fakeClock([
        [60_000, 60_000],
        [0, 3_600_000],
        [60_000, 60_000],
      ]);
      clock.tick();
      clock.tick();
      const baseline = clock.markIdleSince();
      clock.tick();
      expect(clock.awakeMsSince(baseline)).toBe(60_000);
    });
  });
});

/**
 * `advances` are `[monotonicMs, wallMs]` pairs, so a sleep can be modelled as
 * wall time running ahead of a monotonic clock that never moved. Advancing both
 * equally would model a busy machine, not a sleeping one.
 */
function fakeClock(advances: readonly [number, number][]): AwakeClock {
  let monotonic = 0;
  let wall = 0;
  let index = 0;
  return createAwakeClock({
    monotonicMs: () => monotonic,
    wallMs: () => wall,
    // The daemon ticks on a 30s cadence; anything well past that is a sleep.
    sleepThresholdMs: 90_000,
    tick: () => {
      const [monotonicAdvance, wallAdvance] = advances[index] ?? [0, 0];
      index += 1;
      monotonic += monotonicAdvance;
      wall += wallAdvance;
    },
  });
}
