export interface ExitImpactDeps {
  /** Background tasks the *foreground process* owns. */
  readonly backgroundTasks: () => readonly { readonly taskId: string; readonly description?: string }[];
  /** Sub-agents running inside this process. */
  readonly ownedSubAgents: () => number;
  /** Waits for the owned work to finish. */
  readonly wait: () => Promise<void>;
  readonly onNotify?: (message: string) => void;
}

export interface ExitImpactOptions {
  readonly waitForCompletion?: boolean;
}

export interface ExitImpact {
  readonly blocked: boolean;
  readonly ownedTaskCount: number;
  readonly ownedSubAgentCount: number;
  /** Undefined when the session owns nothing. */
  readonly warning?: string;
}

/**
 * What leaving costs, for work this process owns.
 *
 * Opus §3.3.4 point 5: a backgrounded TUI cannot take its own background bash
 * subprocesses or in-process sub-agents with it. The hand-off moves the
 * *session*; the agent loop, the running tools and those children live in the
 * foreground process. Waiting is opt-in, but saying so is not — a user who
 * pressed `←`, watched the session leave, and lost a half-finished command with
 * no mention of it has been given a false picture of what is still running.
 *
 * Never blocks. The user may be leaving deliberately, and a hand-off that
 * refuses to complete over a background task is worse than one that warns.
 */
export async function describeExitImpact(
  deps: ExitImpactDeps,
  options: ExitImpactOptions = {},
): Promise<ExitImpact> {
  const ownedTaskCount = deps.backgroundTasks().length;
  const ownedSubAgentCount = deps.ownedSubAgents();
  if (ownedTaskCount === 0 && ownedSubAgentCount === 0) {
    return { blocked: false, ownedTaskCount, ownedSubAgentCount };
  }

  const parts: string[] = [];
  if (ownedTaskCount > 0) {
    parts.push(`${ownedTaskCount} background ${plural(ownedTaskCount, 'task', 'tasks')}`);
  }
  if (ownedSubAgentCount > 0) {
    parts.push(`${ownedSubAgentCount} sub-${plural(ownedSubAgentCount, 'agent', 'agents')}`);
  }
  const warning =
    `Leaving now stops ${parts.join(' and ')} that this terminal owns. ` +
    'The session goes to the background; these do not.';

  if (options.waitForCompletion === true) {
    await deps.wait();
    deps.onNotify?.(`Finished waiting for ${parts.join(' and ')}.`);
  } else {
    deps.onNotify?.(warning);
  }

  return { blocked: false, ownedTaskCount, ownedSubAgentCount, warning };
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
