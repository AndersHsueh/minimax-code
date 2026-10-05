/** The worker's own answer to "is anything happening?" — `mcode/worker/activity`. */
export interface WorkerActivity {
  readonly runState: 'running' | 'decision-blocked' | 'terminal' | 'idle';
  readonly queuePending: number;
  readonly queuePaused: boolean;
  readonly goalActive: boolean;
  readonly backgroundTasks: number;
}

/** What the daemon knows that the worker cannot tell it. */
export interface WorkerObservation {
  readonly workerAlive: boolean;
  readonly promptInFlight: boolean;
  readonly pendingInteractions: number;
  readonly watchedByClients: number;
  readonly activity: WorkerActivity;
}

export type JobState =
  | 'working'
  | 'needs-input'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface DerivedJobState {
  readonly state: JobState;
  /** Row decorations the agent view renders, e.g. a paused-queue marker. */
  readonly flags: readonly string[];
}

/**
 * May this worker be stopped right now?
 *
 * All conditions must hold at once; any single one is enough to keep it alive.
 * The asymmetry is deliberate — a false "busy" costs a process, a false "idle"
 * costs a job.
 */
export function isWorkerReclaimable(observation: WorkerObservation): boolean {
  // "Reclaim" means "stop this process". A process that is already gone is not
  // reclaimable, it is crashed, and conflating the two hides the crash.
  if (!observation.workerAlive) return false;
  if (observation.promptInFlight) return false;
  // A pending request lives only in the worker's memory, so stopping here loses
  // the very question the user was about to answer.
  if (observation.pendingInteractions > 0) return false;
  // Someone is attached and watching; stopping would pull the view out from
  // under them.
  if (observation.watchedByClients > 0) return false;
  const { activity } = observation;
  // An unpaused queue with pending items dispatches on its own the moment the
  // current turn ends. A *paused* one cannot, which is the whole point of the
  // user's earlier stop.
  if (!activity.queuePaused && activity.queuePending > 0) return false;
  // A Goal starts turns by itself.
  if (activity.goalActive) return false;
  // Background work is owned by this process. Killing it does not stop the bash,
  // it orphans it, and its completion wakes the session with nobody driving.
  if (activity.backgroundTasks > 0) return false;
  return true;
}

/**
 * The row state for the agent view.
 *
 * `recorded` is the last state written to the job file. It is authoritative
 * whenever the worker is gone: a job with no worker must not be started just to
 * find out whether it is busy, which is the whole point of "the process is a
 * cache".
 */
export function deriveJobState(
  observation: WorkerObservation,
  recorded: JobState,
): DerivedJobState {
  const flags = observation.activity.queuePaused ? (['queue-paused'] as const) : ([] as const);
  if (!observation.workerAlive) {
    // Terminal states outrank anything the stale activity payload claims.
    return { state: isTerminal(recorded) ? recorded : 'idle', flags: [] };
  }
  // Needs input outranks Working: a turn that is in flight but has raised a
  // question will not proceed until the user answers it, so showing a spinner
  // would be a lie about what is happening.
  if (observation.pendingInteractions > 0) return { state: 'needs-input', flags };
  if (observation.promptInFlight) return { state: 'working', flags };
  if (observation.activity.runState === 'running' || observation.activity.runState === 'decision-blocked') {
    return { state: 'working', flags };
  }
  if (isTerminal(recorded)) return { state: recorded, flags: [] };
  return { state: 'idle', flags };
}

function isTerminal(state: JobState): boolean {
  return state === 'completed' || state === 'failed' || state === 'stopped';
}
