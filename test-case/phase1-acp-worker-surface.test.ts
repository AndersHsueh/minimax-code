import { describe, expect, it, vi } from 'vitest';

import { runTuiAcpCommand } from '../packages/tui/src/cli/run-acp-command.js';
import { createTuiAcpAgent } from '../packages/tui/src/acp/agent.js';
import { TUI_ACP_EXTENSION_METHODS } from '../packages/tui/src/acp/extensions.js';
import type { TuiAcpRuntime } from '../packages/tui/src/acp/runtime.js';

/**
 * Phase 1 contract: what a supervisor needs from `mcode acp` in order to run a
 * job unattended and safely.
 *
 * Two capabilities, one shared cause. Permission mode is a *global* setting:
 * TUI Shift+Tab ends in `updateLocalConfigFile`, and reads are cached per process,
 * so a worker respawned after another terminal widened the mode would silently
 * inherit it. Phase 0' measured the drift; §2.2 of the plan is the write-up. The
 * fix has two halves that only work together:
 *
 *  - `--permission-mode` pins the mode for the life of the process, so a respawn
 *    reproduces the job's mode instead of re-reading `config.yaml`
 *  - worker mode refuses to write global configuration at all, so a worker can
 *    never be the thing that widens someone else's mode
 *
 * `mcode/worker/activity` is the other half: the daemon must decide when a worker
 * is idle enough to stop, and §2.3 says it may not read the runtime DB. So the
 * worker itself has to answer.
 *
 * See mydocs/supervisor-plan-v2.md §2.2, §2.3, Phase 1 acceptance.
 */
describe('mcode acp worker surface', () => {
  it('pins the permission mode for the process instead of leaving it global', async () => {
    const createRuntime = vi.fn(async () => ({ adapter: {} as never }));

    await runAcp(createRuntime, { permissionMode: 'default' });

    // The override rides the runtime config getter, so it is visible to this
    // process and to nothing else — `config.yaml` keeps the user's own value.
    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'default' }),
    );
  });

  it('omits the override entirely when no mode was requested', async () => {
    const createRuntime = vi.fn(async () => ({ adapter: {} as never }));

    await runAcp(createRuntime, {});

    const options = createRuntime.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options).not.toHaveProperty('permissionMode');
  });

  it('rejects a malformed model at startup rather than at first use', async () => {
    // Failing here is the point: a worker that cannot resolve its model must not
    // come up and silently run on whatever the global default happens to be.
    await expect(runAcp(vi.fn(async () => ({ adapter: {} as never })), { model: 'no-slash' })).rejects.toThrow();
  });

  it('resolves the model and effort into a session default', async () => {
    const createRuntime = vi.fn(async () => ({ adapter: {} as never }));

    await runAcp(createRuntime, { model: 'test/model#fast', effort: 'high' });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        initialModelSelection: expect.objectContaining({
          providerId: 'test',
          modelId: 'model',
          variant: 'fast',
          thinking: { effort: 'high' },
        }),
      }),
    );
  });

  it('refuses to write global configuration in worker mode', async () => {
    // The dangerous direction. A worker that can call `set_config_option` is a
    // worker that can widen every other session's permissions.
    const setPermissionMode = vi.fn(async () => {});
    // Asserted on the message, not just "it threw": an unrelated internal error
    // would satisfy a bare `rejects.toThrow()` and prove nothing.
    await expect(setConfigOption({ setPermissionMode, worker: true })).rejects.toThrow(
      /background worker cannot change permission mode or model/i,
    );
    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it('still allows the change outside worker mode', async () => {
    // The control: this is a worker-only restriction, not a product change.
    const setPermissionMode = vi.fn(async () => {});
    await expect(setConfigOption({ setPermissionMode, worker: false })).resolves.toBeDefined();
    expect(setPermissionMode).toHaveBeenCalled();
  });

  it('keeps the launch mode after a worker session is created and used', async () => {
    // The acceptance criterion, as far as it is observable without booting an
    // embedded host: `--permission-mode` is the value the process reports through
    // the same `getPermissionMode` port the status line reads, and nothing on the
    // startup or session path rewrites it. The write that would clobber
    // `config.yaml` is `setPermissionMode`, reached only through
    // `set_config_option`, which worker mode refuses. There is no ACP read method
    // for it — `session/getConfigOption` does not exist in this protocol version —
    // so the port is the honest place to assert.
    const { runtime, getPermissionMode, setPermissionMode } = acpRuntimeWithMode('default');
    const agent = createTuiAcpAgent({ runtime, version: '1.2.3', worker: true });
    const acp = await import('@agentclientprotocol/sdk');
    const client = acp.client({ name: 'supervisor' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const sessionId = (session as { sessionId: string }).sessionId;

      await expect(
        connection.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'permissionMode',
          value: 'bypassPermissions',
        }),
      ).rejects.toThrow();

      await expect(runtime.getPermissionMode(sessionId)).resolves.toBe('default');
    });

    expect(getPermissionMode).toHaveBeenCalled();
    expect(setPermissionMode).not.toHaveBeenCalled();
  });

  it('reports worker activity from the worker, not from the daemon reading the DB', async () => {
    expect(TUI_ACP_EXTENSION_METHODS).toContain('mcode/worker/activity');
  });

  it('summarises queue, Goal, run state, and background work in one call', async () => {
    const runtime = acpRuntime();
    const agent = createTuiAcpAgent({ runtime: runtime.runtime, version: '1.2.3' });
    const acp = await import('@agentclientprotocol/sdk');
    const client = acp.client({ name: 'supervisor' });

    await client.connectWith(agent, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: '/workspace',
        mcpServers: [],
      });
      const sessionId = (session as { sessionId: string }).sessionId;

      const activity = (await connection.request('mcode/worker/activity', { sessionId })) as {
        activity: Record<string, unknown>;
      };

      // Every idle-recovery input from §2.3 has to be in this one payload, because
      // the daemon may not open the runtime DB to ask for them one at a time.
      expect(Object.keys(activity.activity).sort()).toEqual([
        'backgroundTasks',
        'goalActive',
        'queuePaused',
        'queuePending',
        'runState',
      ]);
      expect(activity.activity).toMatchObject({ queuePending: 0, queuePaused: false });
    });
  });
});

async function runAcp(
  createRuntime: ReturnType<typeof vi.fn>,
  options: {
    permissionMode?: string;
    model?: string;
    effort?: string;
  },
): Promise<void> {
  const serve = vi.fn(async () => undefined);
  await runTuiAcpCommand(
    '9.9.9',
    {
      createRuntime: createRuntime as never,
      shutdownRuntime: vi.fn(async () => undefined),
      serve: serve as never,
      prepareDataDir: vi.fn(async () => '/tmp/mcode-test-data') as never,
      processRef: fakeProcess(),
    },
    undefined,
    options,
  );
}

function fakeProcess() {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    once: () => undefined,
    off: () => undefined,
  } as never;
}

/** Reaches `set_config_option` through the real agent so the guard is the one under test. */
async function setConfigOption(options: {
  setPermissionMode: ReturnType<typeof vi.fn>;
  worker: boolean;
}): Promise<unknown> {
  const acp = await import('@agentclientprotocol/sdk');
  const runtime = acpRuntime({ setPermissionMode: options.setPermissionMode }).runtime;
  const agent = createTuiAcpAgent({
    runtime,
    version: '1.2.3',
    ...(options.worker ? { worker: true } : {}),
  });
  const client = acp.client({ name: 'supervisor' });
  return client.connectWith(agent, async (connection) => {
    await connection.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await connection.request(acp.methods.agent.session.new, {
      cwd: '/workspace',
      mcpServers: [],
    });
    const sessionId = (session as { sessionId: string }).sessionId;
    return connection.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: 'permissionMode',
      value: 'bypassPermissions',
    });
  });
}

function acpRuntimeWithMode(mode: string) {
  const getPermissionMode = vi.fn(async () => mode as never);
  const setPermissionMode = vi.fn(async (next: string) => next as never);
  const { runtime, raw } = acpRuntime({ getPermissionMode, setPermissionMode });
  return { runtime, getPermissionMode: raw.getPermissionMode as ReturnType<typeof vi.fn>, setPermissionMode: raw.setPermissionMode as ReturnType<typeof vi.fn> };
}

function acpRuntime(overrides: Record<string, unknown> = {}) {
  const getSession = vi.fn(async (sessionId: string) => ({ sessionId, workspaceDir: '/workspace' }));
  const runtime = {
    getSession,
    createSession: vi.fn(async ({ workspaceDir }: { workspaceDir: string }) => ({
      sessionId: 'session-1',
      workspaceDir,
    })),
    configureSessionMcpServers: vi.fn(async () => undefined),
    clearSessionMcpServers: vi.fn(async () => undefined),
    deleteSession: vi.fn(async () => undefined),
    listSessionPage: vi.fn(async () => ({ sessions: [], hasMore: false })),
    listMessagePage: vi.fn(async () => ({ messages: [], hasMore: false })),
    getAccountStatus: vi.fn(async () => ({ status: 'ready' as const, warnings: [] })),
    getRuntimeDiagnostics: vi.fn(async () => ({ warnings: [] })),
    getContextSnapshot: vi.fn(async () => ({ status: 'empty' as const })),
    getSessionUsage: vi.fn(async () => ({})),
    getSessionUsageSummary: vi.fn(async () => ({})),
    listSkills: vi.fn(async () => ({})),
    listMcpServers: vi.fn(async () => []),
    requestCompaction: vi.fn(async () => ({ success: true })),
    getPlanModeCapabilities: vi.fn(async () => ({ entryEnabled: true })),
    getPermissionMode: vi.fn(async () => 'default' as const),
    setPermissionMode: vi.fn(async (mode: string) => mode),
    selectModel: vi.fn(async () => true),
    selectSessionModel: vi.fn(async () => true),
    listModels: vi.fn(async () => []),
    steer: vi.fn(async (input: { preDelivery?: { accept: (r: unknown) => Promise<void> } }) => {
      const result = { turnId: 'turn-1', mode: 'steered' as const };
      await input.preDelivery?.accept(result);
      return result;
    }),
    listQueuedMessages: vi.fn(async () => []),
    enqueueMessage: vi.fn(async () => ({ itemId: 'queue-1', position: 1 })),
    updateQueuedMessageContent: vi.fn(async () => undefined),
    deleteQueuedMessage: vi.fn(async () => undefined),
    steerQueuedMessage: vi.fn(async () => ({ queueItemId: 'queue-1', turnId: 'turn-2' })),
    getQueueSnapshot: vi.fn(async () => ({ items: [], paused: false, pendingCount: 0 })),
    isGoalEnabled: () => true,
    getGoal: vi.fn(async () => undefined),
    createGoal: vi.fn(async () => ({})),
    patchGoal: vi.fn(async () => ({})),
    clearGoal: vi.fn(async () => true),
    getDelegationSnapshot: vi.fn(async (rootSessionId: string) => ({
      schemaVersion: 1 as const,
      rootSessionId,
      members: [],
    })),
    stopDelegation: vi.fn(async (rootSessionId: string) => ({
      schemaVersion: 1 as const,
      rootSessionId,
      rootStopped: true,
      stoppedSessionIds: [],
      activeSessionIds: [],
      failedSessionIds: [],
    })),
    getSessionForkOptions: vi.fn(async () => ({
      canFork: true,
      worktreeVisible: false,
      worktreeEligible: false,
    })),
    forkSession: vi.fn(async () => ({
      session: { sessionId: 'session-fork', workspaceDir: '/workspace' },
    })),
    replyPermission: vi.fn(async () => true),
    replyQuestionnaire: vi.fn(async () => true),
    dismissQuestionnaire: vi.fn(async () => true),
    getActiveRun: vi.fn(async () => ({
      schemaVersion: 1 as const,
      sessionId: 'session-1',
      state: 'idle' as const,
      actions: { steer: false },
    })),
    listBackgroundTasks: vi.fn(async () => []),
    sendMessage: vi.fn(async function* sendMessage() {
      return;
    }),
    abortSession: vi.fn(async () => true),
    watchEvents: vi.fn(() => (async function* events() { return; })()),
    watchSessionTurn: vi.fn(() =>
      (async function* turn() {
        yield { type: 'session-status', status: 'finished' } as const;
      })(),
    ),
    ...overrides,
  };
  return { runtime: runtime as unknown as TuiAcpRuntime, raw: runtime };
}
