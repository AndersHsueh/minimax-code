import { Console } from 'node:console';
import type { Readable, Writable } from 'node:stream';

import { serveTuiAcpStdio } from '../acp/stdio.js';
import { parseHeadlessModelOverride } from '../headless/model-selection.js';
import { prepareTuiDataDir } from '../runtime/data-dir.js';
import type { TuiSessionModelSelection } from '../runtime/port.js';
import type {
  CreatedTuiRuntime,
  createTuiRuntime,
  shutdownTuiRuntime,
} from '../runtime/lifecycle.js';

type TuiTerminationSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';

interface TuiAcpProcess {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  once(signal: TuiTerminationSignal, listener: () => void): unknown;
  off(signal: TuiTerminationSignal, listener: () => void): unknown;
}

export interface RunTuiAcpCommandDependencies {
  readonly processRef?: TuiAcpProcess;
  readonly workspaceDir?: () => string;
  readonly prepareDataDir?: typeof prepareTuiDataDir;
  readonly createRuntime?: typeof createTuiRuntime;
  readonly shutdownRuntime?: typeof shutdownTuiRuntime;
  readonly serve?: typeof serveTuiAcpStdio;
  readonly loadRuntimeLifecycle?: () => Promise<{
    createTuiRuntime: typeof createTuiRuntime;
    shutdownTuiRuntime: typeof shutdownTuiRuntime;
  }>;
}

export interface RunTuiAcpCommandOptions {
  /** Pins the permission mode for this process. A background worker is respawned
   *  from its job file, and a respawn that re-reads `config.yaml` would silently
   *  inherit whatever another terminal last wrote. */
  readonly permissionMode?: string;
  readonly model?: string;
  readonly effort?: string;
}

/** Command-line shape; identical to {@link RunTuiAcpCommandOptions} by design. */
export type RawTuiAcpOptions = RunTuiAcpCommandOptions;

export async function runTuiAcpCommand(
  version: string,
  dependencies: RunTuiAcpCommandDependencies = {},
  lane?: string,
  options: RunTuiAcpCommandOptions = {},
): Promise<void> {
  const processRef = dependencies.processRef ?? process;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('ACP process is stopping.'));
  const restoreConsole = redirectConsoleOutputToStderr(processRef.stderr);
  let runtime: CreatedTuiRuntime | undefined;
  let shutdownRuntime = dependencies.shutdownRuntime;
  processRef.once('SIGINT', cancel);
  processRef.once('SIGTERM', cancel);
  processRef.once('SIGHUP', cancel);
  try {
    const lifecycle =
      dependencies.createRuntime && dependencies.shutdownRuntime
        ? {
            createTuiRuntime: dependencies.createRuntime,
            shutdownTuiRuntime: dependencies.shutdownRuntime,
          }
        : await (dependencies.loadRuntimeLifecycle ?? (() => import('../runtime/lifecycle.js')))();
    const createRuntime = dependencies.createRuntime ?? lifecycle.createTuiRuntime;
    shutdownRuntime ??= lifecycle.shutdownTuiRuntime;
    const dataDir = await (dependencies.prepareDataDir ?? prepareTuiDataDir)();
    // Parsed before the runtime exists: a worker whose model cannot be resolved
    // must fail here, not after it has already claimed a job.
    const initialModelSelection = resolveAcpModelSelection(options);
    runtime = await createRuntime({
      dataDir,
      workspaceDir: (dependencies.workspaceDir ?? (() => process.cwd()))(),
      version,
      surface: 'acp',
      ...(lane ? { lane } : {}),
      ...(options.permissionMode
        ? { permissionMode: options.permissionMode as never }
        : {}),
      ...(initialModelSelection ? { initialModelSelection } : {}),
    });
    await (dependencies.serve ?? serveTuiAcpStdio)({
      runtime: runtime.adapter,
      version,
      input: processRef.stdin,
      output: processRef.stdout,
      signal: controller.signal,
    });
  } finally {
    processRef.off('SIGINT', cancel);
    processRef.off('SIGTERM', cancel);
    processRef.off('SIGHUP', cancel);
    try {
      if (runtime && shutdownRuntime) await shutdownRuntime(runtime);
    } finally {
      restoreConsole();
    }
  }
}

/** Same `provider/model#variant` syntax and same `#variant`-vs-`--effort` split as `exec`. */
function resolveAcpModelSelection(
  options: RunTuiAcpCommandOptions,
): TuiSessionModelSelection | undefined {
  const requested = options.model
    ? parseHeadlessModelOverride(options.model)
    : undefined;
  if (!requested && options.effort === undefined) return undefined;
  return {
    ...requested,
    ...(options.effort ? { thinking: { effort: options.effort } } : {}),
  };
}

function redirectConsoleOutputToStderr(stderr: Writable): () => void {
  const original = globalThis.console;
  globalThis.console = new Console({ stdout: stderr, stderr });
  return () => {
    globalThis.console = original;
  };
}
