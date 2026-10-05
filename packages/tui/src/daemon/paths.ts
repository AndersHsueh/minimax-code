import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every path a daemon touches is derived from its `dataDir`, never from a
 * hardcoded home. `runtime/data-dir.ts` honours `MINIMAX_DATA_DIR` and
 * `MAVIS_DATA_DIR`, so one user can legitimately run several isolated daemons at
 * once — the singleton boundary is a dataDir, not a person.
 */
export interface DaemonPaths {
  readonly dataDir: string;
  readonly daemonDir: string;
  readonly lockFile: string;
  readonly capabilityFile: string;
  readonly rosterFile: string;
  readonly jobsDir: string;
  readonly logsDir: string;
  readonly socketFile: string;
  readonly socketIsFallback: boolean;
}

export function daemonPaths(dataDir: string, uid: number | string = currentUid()): DaemonPaths {
  const socket = resolveDaemonSocketPath(dataDir, uid);
  return {
    dataDir,
    daemonDir: join(dataDir, 'daemon'),
    lockFile: join(dataDir, 'daemon', 'daemon.lock'),
    capabilityFile: join(dataDir, 'daemon', 'daemon.cap'),
    rosterFile: join(dataDir, 'daemon', 'roster.json'),
    jobsDir: join(dataDir, 'daemon', 'jobs'),
    logsDir: join(dataDir, 'daemon', 'logs'),
    socketFile: socket.path,
    socketIsFallback: socket.isFallback,
  };
}

/**
 * `sun_path` is 104 bytes on macOS and 108 on Linux, and a dataDir is chosen by
 * the user, so a long one produces a socket the kernel will refuse to bind — with
 * an error that mentions nothing about length. Fall back to a per-dataDir path
 * under a directory only this user can write, so two daemons cannot collide and
 * another user cannot pre-create it.
 */
export function resolveDaemonSocketPath(dataDir: string, uid: number | string = currentUid()): {
  path: string;
  isFallback: boolean;
} {
  const limit = sunPathLimit();
  const preferred = join(dataDir, 'run', 'mcode-daemon.sock');
  if (withinSunPath(preferred, limit)) return { path: preferred, isFallback: false };
  const digest = createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
  const fallback = join(tmpdir(), `mcode-daemon-${uid}`, `${digest}.sock`);
  return { path: fallback, isFallback: true };
}

function withinSunPath(candidate: string, limit: number): boolean {
  return Buffer.byteLength(candidate) < limit;
}

function sunPathLimit(): number {
  return process.platform === 'darwin' ? 104 : 108;
}

function currentUid(): number | string {
  return typeof process.getuid === 'function' ? process.getuid() : 'uid';
}
