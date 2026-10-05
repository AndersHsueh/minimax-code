export interface AwakeClockOptions {
  /** Monotonic time. Never jumps, so it is the only trustworthy idle measure. */
  readonly monotonicMs: () => number;
  /** Wall time. Jumps across sleep, which is exactly what makes it useful as a
   *  second signal: a large gap between ticks means the machine was asleep. */
  readonly wallMs: () => number;
  readonly sleepThresholdMs?: number;
  /** Test seam for advancing both clocks. */
  readonly tick: (advanceMs: number) => void;
}

export interface AwakeClock {
  /** Advance one tick and report whether the gap looked like sleep. */
  tick(): boolean;
  readonly lastTickSlept: boolean;
  /** Awake milliseconds elapsed since a monotonic baseline, sleep excluded. */
  awakeMsSince(monotonicBaseline: number): number;
  /** A baseline to measure an idle window from, right now. */
  markIdleSince(): number;
}

/** The daemon's default cadence; a gap far beyond it is sleep, not jitter. */
export const DAEMON_TICK_MS = 30_000;
const DEFAULT_SLEEP_THRESHOLD_MS = 3 * DAEMON_TICK_MS;

/**
 * Idle time measured in *awake* time only.
 *
 * A daemon that counts wall-clock idle will decide a worker is long-idle the
 * instant a laptop wakes from an hour of sleep, and reclaim a session that was
 * never actually unattended. Monotonic time cannot detect sleep on its own, so
 * the two are compared: a tick whose wall-clock delta far exceeds its
 * monotonic delta means the process was not running for part of that gap, and
 * that part is not counted.
 */
export function createAwakeClock(options: AwakeClockOptions): AwakeClock {
  const sleepThresholdMs = options.sleepThresholdMs ?? DEFAULT_SLEEP_THRESHOLD_MS;
  const segments: { from: number; to: number }[] = [];
  let lastMonotonic = options.monotonicMs();
  let lastWall = options.wallMs();
  let slept = false;

  return {
    tick(): boolean {
      // Advance first, then measure: a tick reports the gap that just happened.
      options.tick();
      const now = options.monotonicMs();
      const wall = options.wallMs();
      const monotonicDelta = Math.max(0, now - lastMonotonic);
      const wallDelta = Math.max(0, wall - lastWall);
      // The threshold has headroom for a busy event loop; anything inside it is
      // jitter, and counting it as sleep would zero the idle timer constantly.
      slept = wallDelta - monotonicDelta > sleepThresholdMs;
      if (!slept && monotonicDelta > 0) {
        segments.push({ from: lastMonotonic, to: now });
      }
      lastMonotonic = now;
      lastWall = wall;
      return slept;
    },
    get lastTickSlept(): boolean {
      return slept;
    },
    awakeMsSince(monotonicBaseline: number): number {
      let total = 0;
      for (const segment of segments) {
        if (segment.to <= monotonicBaseline) continue;
        total += segment.to - Math.max(segment.from, monotonicBaseline);
      }
      return total;
    },
    markIdleSince(): number {
      return options.monotonicMs();
    },
  };
}
