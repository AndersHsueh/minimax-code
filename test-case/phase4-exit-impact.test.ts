import { describe, expect, it, vi } from 'vitest';

import { describeExitImpact } from '../packages/tui/src/tui/features/agents/exit-impact.js';

/**
 * Phase 4 contract: what happens to work the foreground process still owns.
 *
 * Opus §3.3.4 point 5 and the last line of §5.6.1 both say the same thing, and
 * it is the one part of the hand-off that cannot be deferred to the daemon: a
 * backgrounded TUI cannot take its own background bash subprocesses or its
 * in-process sub-agents with it. The agent loop, the running tools and those
 * children all live in the foreground process, and a `←` hand-off moves the
 * *session*, not the operating system.
 *
 * So the honest options are to wait or to say so. The rule this encodes is that
 * saying so is mandatory and waiting is opt-in — because the alternative is a
 * user who pressed `←`, saw the session leave, and lost a half-finished
 * command with no indication it ever existed.
 */
describe('exit impact', () => {
  function deps(overrides: Partial<Parameters<typeof describeExitImpact>[0]> = {}) {
    return {
      backgroundTasks: () => [] as readonly { taskId: string; description?: string }[],
      ownedSubAgents: () => 0,
      wait: async () => undefined,
      onNotify: vi.fn(),
      ...overrides,
    };
  }

  it('says nothing when the session owns no background work', async () => {
    const d = deps();

    const result = await describeExitImpact(d);

    expect(result.blocked).toBe(false);
    expect(d.onNotify).not.toHaveBeenCalled();
  });

  it('warns when the foreground still owns a background task', async () => {
    const d = deps({ backgroundTasks: () => [{ taskId: 'bg-1', description: 'npm test' }] });

    const result = await describeExitImpact(d);

    // Not a hard block: the user may be leaving on purpose. But they are told,
    // which is the whole requirement.
    expect(result.blocked).toBe(false);
    expect(result.warning).toMatch(/1/);
  });

  it('counts the running sub-agents in the warning', async () => {
    const d = deps({ ownedSubAgents: () => 2 });

    const result = await describeExitImpact(d);

    expect(result.warning).toMatch(/2/);
    expect(result.warning).toMatch(/sub-?agent/i);
  });

  it('reports both kinds of owned work in one message', async () => {
    const d = deps({
      backgroundTasks: () => [{ taskId: 'bg-1' }],
      ownedSubAgents: () => 1,
    });

    const result = await describeExitImpact(d);

    expect(result.warning).toMatch(/1/);
    expect(result.ownedTaskCount).toBe(1);
    expect(result.ownedSubAgentCount).toBe(1);
  });

  it('waits for the owned work when the user chooses to', async () => {
    const wait = vi.fn(async () => undefined);
    const d = deps({ backgroundTasks: () => [{ taskId: 'bg-1' }], wait });

    await describeExitImpact(d, { waitForCompletion: true });

    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('does not wait when the user leaves anyway', async () => {
    const wait = vi.fn(async () => undefined);
    const d = deps({ backgroundTasks: () => [{ taskId: 'bg-1' }], wait });

    await describeExitImpact(d, { waitForCompletion: false });

    expect(wait).not.toHaveBeenCalled();
  });

  it('still notifies after waiting, so the outcome is never silent', async () => {
    const d = deps({
      backgroundTasks: () => [{ taskId: 'bg-1' }],
      onNotify: vi.fn(),
    });

    await describeExitImpact(d, { waitForCompletion: true });

    expect(d.onNotify).toHaveBeenCalled();
  });

  it('tells the user these tasks do not go to the background', async () => {
    // The distinction that matters: the *session* is handed off, these are not.
    // Without it, a user reasonably assumes the agent is still working.
    const d = deps({ backgroundTasks: () => [{ taskId: 'bg-1' }] });

    const result = await describeExitImpact(d);

    expect(result.warning).toMatch(/background|stopped|not (?:be )?carried/i);
  });
});
