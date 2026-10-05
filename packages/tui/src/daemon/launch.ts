export interface DaemonSpawnOptions {
  readonly dataDir: string;
  readonly entry: string;
  /** An open fd for the log file. Passed through as a number so the child
   *  inherits the descriptor rather than a path it would have to reopen. */
  readonly logFd: number;
  readonly env?: Record<string, string | undefined>;
  readonly execPath?: string;
}

/**
 * How `mcode daemon run` is spawned.
 *
 * Three properties are load-bearing and each one is a known way a long-lived
 * background process dies or leaks:
 *
 *  - `detached` puts the child in a new session, so closing the terminal SIGHUPs
 *    the *user's* process group and not the daemon's workers.
 *  - stdio is redirected to the log. Inheriting a TUI's stdio corrupts the TUI
 *    and hands the daemon a controlling terminal it can be signalled through.
 *  - the capability token is stripped from `env`. Anything in the environment is
 *    readable from `/proc/<pid>/environ` by the same user and is inherited by
 *    every worker the daemon later spawns. The child reads the token from the
 *    capability file instead.
 *
 * `cwd` is the dataDir, not the user's project, so a daemon does not hold a
 * project directory open or pick up its relative paths.
 */
export function buildDaemonSpawn(options: DaemonSpawnOptions): {
  args: string[];
  detached: true;
  stdio: ['ignore', number, number];
  cwd: string;
  env: Record<string, string>;
} {
  const inherited = options.env ?? (process.env as Record<string, string | undefined>);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    // Anything that could carry a credential out of the parent's environment.
    if (/TOKEN|SECRET|PASSWORD|CAPABILITY|DAEMON_CAP/i.test(key)) continue;
    env[key] = value;
  }
  env.MINIMAX_DATA_DIR = options.dataDir;
  return {
    args: [options.entry, 'daemon', 'run'],
    detached: true,
    stdio: ['ignore', options.logFd, options.logFd],
    cwd: options.dataDir,
    env,
  };
}
