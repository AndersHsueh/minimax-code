import { connect, type Socket } from 'node:net';

import {
  DAEMON_DEFAULT_IDLE_TIMEOUT_MS,
  DAEMON_ERROR_CODES,
  DAEMON_PROTO,
  drainNdjsonBuffer,
  isNotificationFrame,
  isResponseFrame,
  serializeFrame,
  type DaemonRequestFrame,
} from './ndjson.js';
import { readCapabilityFile } from './capability.js';
import { daemonPaths } from './paths.js';

export interface ConnectDaemonOptions {
  readonly socketFile?: string;
  /** Omit to read the token from the dataDir's capability file. */
  readonly token?: string;
  readonly dataDir?: string;
  readonly version: string;
  readonly kind?: string;
  readonly idleTimeoutMs?: number;
}

export interface DaemonClient {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  /**
   * Registers the handler for server-initiated frames.
   *
   * The footer's awaiting badge is a subscription rather than a poll (§3.5), so
   * this is the only way state ever arrives once the handshake is done. A client
   * that never registers one — `mcode agents` — simply ignores pushes, which is
   * why the daemon treats every connection as a target instead of making
   * clients opt in and then forget to.
   */
  onNotification(handler: (method: string, params: unknown) => void): void;
  close(): void;
}

export class DaemonClientError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonClientError';
  }
}

/**
 * Connects to a running daemon and completes the handshake.
 *
 * The token comes from the capability file, never from the environment: `daemon
 * run` is spawned detached with a sanitized env, and anything in `env` is
 * readable from `/proc/<pid>/environ` by the same user and inherited by children.
 */
export async function connectDaemon(options: ConnectDaemonOptions): Promise<DaemonClient> {
  const socketFile = options.socketFile ?? daemonPaths(requireDataDir(options)).socketFile;
  const token = options.token ?? (await readCapabilityFile(daemonPaths(requireDataDir(options)).capabilityFile));

  const socket = await openSocket(socketFile);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let notificationHandler: ((method: string, params: unknown) => void) | undefined;
  let nextId = 1;
  let buffer = '';
  let closed = false;

  const failAll = (error: Error) => {
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const drained = drainNdjsonBuffer(buffer);
    buffer = drained.rest;
    for (const frame of drained.frames) {
      // Checked before the response branch: a push has no `id`, so the pending
      // lookup below would find nothing and drop it on the floor.
      if (isNotificationFrame(frame)) {
        notificationHandler?.(frame.method, frame.params);
        continue;
      }
      if (!isResponseFrame(frame)) continue;
      const response = frame as {
        id?: unknown;
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (typeof response.id !== 'number') continue;
      const entry = pending.get(response.id);
      if (!entry) continue;
      pending.delete(response.id);
      if (response.error) {
        entry.reject(new DaemonClientError(response.error.code, response.error.message));
      } else {
        entry.resolve(response.result);
      }
    }
  });
  socket.on('close', () => {
    closed = true;
    failAll(new DaemonClientError(DAEMON_ERROR_CODES.internal, 'The daemon closed the connection.'));
  });
  socket.on('error', (error) => failAll(error));

  // Idle means *no work in flight*, not "no bytes for N seconds".
  //
  // A request like `job.send` can legitimately take longer than the timeout — it
  // may start a worker, load its session, and only then answer. Treating that as
  // idle reports a daemon that is working perfectly as one that closed the
  // connection, and throws away the delivery answer with it.
  let inFlight = 0;
  const armIdleTimer = (): void => {
    const limit = options.idleTimeoutMs;
    if (limit === undefined) return;
    socket.setTimeout(inFlight > 0 ? 0 : limit, () => {
      if (inFlight === 0) socket.destroy();
    });
  };
  armIdleTimer();

  const client: DaemonClient = {
    request: (method, params) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new DaemonClientError(DAEMON_ERROR_CODES.internal, 'The connection is closed.'));
          return;
        }
        const id = nextId++;
        inFlight += 1;
        armIdleTimer();
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          inFlight = Math.max(0, inFlight - 1);
          armIdleTimer();
        };
        pending.set(id, {
          resolve: (value) => {
            settle();
            resolve(value);
          },
          reject: (error) => {
            settle();
            reject(error);
          },
        });
        socket.write(
          serializeFrame({
            jsonrpc: '2.0',
            id,
            method,
            ...(params === undefined ? {} : { params }),
          } as DaemonRequestFrame),
        );
      }),
    notify: (method, params) => {
      if (closed) return;
      socket.write(
        serializeFrame({
          jsonrpc: '2.0',
          id: null,
          method,
          ...(params === undefined ? {} : { params }),
        } as DaemonRequestFrame),
      );
    },
    onNotification: (handler) => {
      notificationHandler = handler;
    },
    close: () => socket.destroy(),
  };

  await client.request('hello', {
    proto: DAEMON_PROTO,
    token,
    client: { kind: options.kind ?? 'cli', pid: process.pid, version: options.version },
  });
  return client;
}

function requireDataDir(options: ConnectDaemonOptions): string {
  if (!options.dataDir) {
    throw new Error('A dataDir is required to locate the daemon socket.');
  }
  return options.dataDir;
}

async function openSocket(socketFile: string): Promise<Socket> {
  const socket = connect(socketFile);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  // A client that hangs around forever is a leak; the default matches the server.
  socket.setTimeout(DAEMON_DEFAULT_IDLE_TIMEOUT_MS, () => socket.destroy());
  return socket;
}
