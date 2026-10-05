const PERMISSION_MODES = ['default', 'auto', 'bypassPermissions', 'off'] as const;
export type WorkerPermissionMode = (typeof PERMISSION_MODES)[number];

export interface JobLaunchRecord {
  readonly permissionMode?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly lane?: string;
  readonly cliVersion?: string;
}

export interface ResolveWorkerLaunchInput {
  /** The job file, as read from disk. */
  readonly job: { readonly launch?: JobLaunchRecord; readonly lane?: string };
  /** What the global config says right now. Never used for a recorded field. */
  readonly globalPermissionMode?: string;
  readonly globalModel?: string;
}

export interface WorkerLaunchPlan {
  readonly permissionMode: WorkerPermissionMode;
  readonly model?: string;
  readonly effort?: string;
  readonly lane?: string;
}

/**
 * The values a worker is started with, taken from its job file and nothing else.
 *
 * Permission mode is global and backed by `<dataDir>/config.yaml`, and reads are
 * cached per process. A worker is respawned whenever it goes idle, and if it read
 * the global value then, any other terminal that widened the mode in the
 * meantime would silently widen this job too — the user sees no prompt and no
 * reason to look. Recording the mode at job creation and passing it explicitly
 * removes the window; the global value is deliberately not consulted.
 *
 * A job with no recorded mode has no safe fallback and throws. Defaulting to
 * "whatever is configured" is precisely the drift this exists to prevent, and
 * failing loudly is the only response that surfaces a bad job record.
 */
export function resolveWorkerLaunch(input: ResolveWorkerLaunchInput): WorkerLaunchPlan {
  const recorded = input.job.launch?.permissionMode;
  if (!isPermissionMode(recorded)) {
    throw new Error(
      `Job does not record a usable --permission-mode (found ${JSON.stringify(recorded)}). ` +
        'Refusing to start a worker whose permissions would come from the global setting.',
    );
  }
  return {
    permissionMode: recorded,
    ...(input.job.launch?.model ? { model: input.job.launch.model } : {}),
    ...(input.job.launch?.effort ? { effort: input.job.launch.effort } : {}),
    ...(input.job.launch?.lane ?? input.job.lane ? { lane: input.job.launch?.lane ?? input.job.lane } : {}),
  };
}

function isPermissionMode(value: unknown): value is WorkerPermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}
