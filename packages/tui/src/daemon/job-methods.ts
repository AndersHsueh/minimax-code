import type { DaemonJobStore } from './job-store.js';

export interface DaemonJobMethods {
  readonly jobs: DaemonJobStore;
  readonly listJobs: (input: { includeEnded?: boolean }) => Promise<Record<string, unknown>[]>;
  readonly send: (input: { sessionId: string; text: string; mode: 'queue' | 'steer' }) => Promise<unknown>;
  readonly stop: (input: { sessionId: string }) => Promise<unknown>;
  readonly remove: (input: { sessionId: string }) => Promise<unknown>;
  readonly reply: (input: {
    sessionId: string;
    interactionId: string;
    outcome: string;
  }) => Promise<{ rejected: 'rejected' | 'not-interactive' | 'unknown-interaction' }>;
}

export interface JobClient {
  readonly kind: string;
}

const ENDED_STATES = new Set(['completed', 'failed', 'stopped']);

/**
 * The job methods from §3.5, minus the ones that need a live worker.
 *
 * Two behaviours are safety rules rather than interface choices:
 *
 *  - `job.reply` is refused for anything that is not an interactive TUI client.
 *    A background job parked on a permission question has to be answered by
 *    someone who can see what it is asking; approving it blind from a CLI is how
 *    a job ends up unrestricted by accident.
 *  - a send that cannot reach a worker is staged on disk rather than dropped, and
 *    a message that is exactly `/stop` is a stop. A dropped message loses work
 *    the user believes was sent; a queued `/stop` leaves a job running that they
 *    believe they stopped.
 */
export async function routeJobMethod(
  methods: DaemonJobMethods,
  method: string,
  params: unknown,
  client: JobClient,
): Promise<unknown> {
  const input = asRecord(params);
  switch (method) {
    case 'jobs.list': {
      const includeEnded = input.includeEnded === true;
      const sessionIds = await methods.jobs.listJobs();
      const kept: string[] = [];
      for (const sessionId of sessionIds) {
        const job = await methods.jobs.readJob(sessionId);
        if (!includeEnded && ENDED_STATES.has(String(job?.state ?? 'idle'))) continue;
        kept.push(sessionId);
      }
      // The row contents come from the caller's own source; the durable set is
      // what decides which sessions exist at all.
      return { jobs: await methods.listJobs({ includeEnded }), sessionIds: kept };
    }
    case 'job.send': {
      const sessionId = requireText(input.sessionId, 'sessionId');
      const text = requireText(input.text, 'text');
      const mode = input.mode === 'steer' ? 'steer' : 'queue';
      if (text.trim() === '/stop') {
        return methods.stop({ sessionId });
      }
      try {
        return await methods.send({ sessionId, text, mode });
      } catch {
        // The worker may be starting or may have just crashed. Stage it: a
        // dropped message loses work the user believes was sent, and replay
        // order is preserved by the store's time-ordered filenames.
        await methods.jobs.stagePending(sessionId, { text, mode });
        return { delivered: false, staged: true, reason: 'worker-unavailable' };
      }
    }
    case 'job.stop':
      return methods.stop({ sessionId: requireText(input.sessionId, 'sessionId') });
    case 'job.remove': {
      const sessionId = requireText(input.sessionId, 'sessionId');
      await methods.jobs.removeJob(sessionId);
      return methods.remove({ sessionId });
    }
    case 'job.reply': {
      if (client.kind !== 'tui') return { rejected: 'not-interactive' };
      return methods.reply({
        sessionId: requireText(input.sessionId, 'sessionId'),
        interactionId: requireText(input.interactionId, 'interactionId'),
        outcome: requireText(input.outcome, 'outcome'),
      });
    }
    default:
      throw new Error(`Unknown daemon job method: ${method}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}
