import { createCapabilityFile, readCapabilityFile } from './capability.js';
import { connectDaemon, type DaemonClient } from './client.js';
import { daemonPaths } from './paths.js';
import { startDaemonServer, type RunningDaemon } from './server.js';
import { acquireDaemonSingleton } from './singleton.js';

/** Exit codes the daemon command uses. */
export const DAEMON_EXIT = {
  ok: 0,
  usage: 2,
  failed: 1,
} as const;

const PERMISSION_MODES = ['default', 'auto', 'bypassPermissions', 'off'] as const;

export interface DaemonCommandOptions {
  readonly dataDir: string;
  readonly permissionMode?: string;
  readonly drain?: boolean;
  /** Injected so tests can observe the exit path without ending the process. */
  readonly exit?: (code: number) => Promise<void> | void;
  readonly report?: DaemonCommandReport;
}

export interface DaemonCommandDependencies {
  readonly version: string;
  readonly now?: () => number;
}

export type DaemonStatusReport =
  | { readonly running: false; readonly reason: string }
  | {
      readonly running: true;
      readonly epoch: number;
      readonly socketFile: string;
      readonly daemonVersion: string;
      readonly workers: number;
    };

export type DaemonStopReport = { readonly stopped: true } | { readonly stopped: false; readonly reason: string };

/** Where subcommand output goes. Injected so tests can read it. */
export interface DaemonCommandReport {
  write(line: string): void;
}

const defaultReport: DaemonCommandReport = { write: (line) => process.stdout.write(line) };

export interface DaemonRunHandle {
  readonly started: Promise<{ acquired: boolean; socketFile: string }>;
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

/**
 * `mcode daemon run | status | stop`.
 *
 * The lock is taken before the socket is touched, so a process that loses the
 * race never reaches the socket: it cannot unlink the incumbent's address or
 * bind over it. That loser exits 0 and names the winner — a non-zero exit would
 * read as "the daemon failed to start" and send people hunting a bug that is not
 * there.
 */
export function runDaemonCommand(
  subcommand: 'run',
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): DaemonRunHandle;
export function runDaemonCommand(
  subcommand: 'status',
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): Promise<DaemonStatusReport>;
export function runDaemonCommand(
  subcommand: 'stop',
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): Promise<DaemonStopReport>;
export function runDaemonCommand(
  subcommand: string,
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): DaemonRunHandle | Promise<DaemonStatusReport | DaemonStopReport> {
  switch (subcommand) {
    case 'run':
      return runDaemon(options, dependencies);
    case 'status':
      return daemonStatus(options, dependencies);
    case 'stop':
      return daemonStop(options, dependencies);
    default:
      return Promise.reject(
        new Error(`Unknown \`mcode daemon\` subcommand: ${subcommand}. Use run, status, or stop.`),
      );
  }
}

function runDaemon(
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): DaemonRunHandle {
  const report = options.report ?? defaultReport;
  if (options.permissionMode !== undefined && !isPermissionMode(options.permissionMode)) {
    // The mode is written into a file a later respawn reads verbatim, so a typo
    // would produce a job with no effective permissions and no error.
    return rejected(
      new Error(
        `Unknown --permission-mode: ${options.permissionMode}. Use one of ${PERMISSION_MODES.join(', ')}.`,
      ),
    );
  }
  const paths = daemonPaths(options.dataDir);
  let stopServer: (() => Promise<void>) | undefined;
  let settle: (() => void) | undefined;
  let stopped = false;
  const started = (async () => {
    const singleton = await acquireDaemonSingleton({ dataDir: options.dataDir });
    if (!singleton.acquired) {
      // Losing the race is not a failure. Print who won so the second terminal
      // says "already running, here it is" instead of going quiet, and exit 0 —
      // a non-zero code reads as "the daemon failed to start" and sends people
      // hunting a bug that is not there.
      report.write(describeIncumbent(await probeIncumbent(paths, dependencies.version)));
      await options.exit?.(DAEMON_EXIT.ok);
      return { acquired: false, socketFile: paths.socketFile };
    }
    const token = await createCapabilityFile(paths.capabilityFile);
    const server = await startDaemonServer({
      dataDir: options.dataDir,
      token,
      version: dependencies.version,
      epoch: (dependencies.now ?? Date.now)(),
      onStop: () => stopServer?.(),
    });
    stopServer = async () => {
      if (stopped) return;
      stopped = true;
      await server.stop();
      await singleton.release();
      settle?.();
    };
    return { acquired: true, socketFile: server.socketFile };
  })();

  return {
    started,
    // `mcode daemon run` is its own process lifetime: it serves until a signal
    // or an explicit stop, then the socket and the lock are released together so
    // the next start never inherits a half-torn-down singleton.
    done: started.then(
      async (result) => {
        if (!result.acquired) return;
        await new Promise<void>((resolve) => {
          settle = resolve;
          const stop = () => void stopServer?.();
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
          process.once('SIGHUP', stop);
        });
      },
      (error) => {
        void options.exit?.(DAEMON_EXIT.failed);
        throw error;
      },
    ),
    stop: async () => {
      await stopServer?.();
    },
  };
}

async function daemonStatus(
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): Promise<DaemonStatusReport> {
  const paths = daemonPaths(options.dataDir);
  let token: string;
  try {
    token = await readCapabilityFile(paths.capabilityFile);
  } catch {
    // `status` is a diagnostic people run when things look wrong. "not running"
    // has to be an answer, not a stack trace.
    return { running: false, reason: 'No daemon capability token; no daemon has started here.' };
  }
  const client = await connectDaemon({
    socketFile: paths.socketFile,
    token,
    version: dependencies.version,
  }).catch(() => undefined);
  if (!client) {
    return { running: false, reason: `A token exists but nothing is listening on ${paths.socketFile}.` };
  }

  try {
    const status = (await client.request('daemon.status')) as {
      epoch: number;
      socketFile: string;
      daemonVersion: string;
      workers: number;
    };
    return {
      running: true,
      epoch: status.epoch,
      socketFile: status.socketFile,
      daemonVersion: status.daemonVersion,
      workers: status.workers,
    };
  } finally {
    client.close();
  }
}

async function daemonStop(
  options: DaemonCommandOptions,
  dependencies: DaemonCommandDependencies,
): Promise<DaemonStopReport> {
  const paths = daemonPaths(options.dataDir);
  let token: string;
  try {
    token = await readCapabilityFile(paths.capabilityFile);
  } catch (error) {
    return { stopped: false, reason: `No daemon to stop: ${describe(error)}` };
  }
  const client: DaemonClient | undefined = await connectDaemon({
    socketFile: paths.socketFile,
    token,
    version: dependencies.version,
  }).catch(() => undefined);
  if (!client) {
    return {
      stopped: false,
      reason: `The daemon at ${paths.socketFile} did not accept the stop.`,
    };
  }
  try {
    await client.request('daemon.stop', { drain: options.drain === true });
    return { stopped: true };
  } catch (error) {
    return { stopped: false, reason: describe(error) };
  } finally {
    client.close();
  }
}

async function probeIncumbent(
  paths: ReturnType<typeof daemonPaths>,
  version: string,
): Promise<string> {
  let token: string;
  try {
    token = await readCapabilityFile(paths.capabilityFile);
  } catch {
    return `another daemon holds ${paths.lockFile} but is not reachable yet; retry in a moment`;
  }
  const client = await connectDaemon({ socketFile: paths.socketFile, token, version }).catch(
    () => undefined,
  );
  if (!client) return `another daemon already holds ${paths.lockFile}`;
  try {
    const status = (await client.request('daemon.status')) as { epoch: number; daemonVersion: string };
    return `daemon already running (epoch ${status.epoch}, version ${status.daemonVersion}, ${paths.socketFile})`;
  } catch {
    return `another daemon already holds ${paths.lockFile}`;
  } finally {
    client.close();
  }
}

function describeIncumbent(line: string): string {
  return `${line}\n`;
}

function isPermissionMode(value: string): boolean {
  return (PERMISSION_MODES as readonly string[]).includes(value);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rejected(error: Error): DaemonRunHandle {
  return {
    started: Promise.reject(error),
    done: Promise.resolve(),
    stop: async () => undefined,
  };
}

export type { RunningDaemon };
