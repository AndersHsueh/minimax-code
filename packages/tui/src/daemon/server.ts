import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';

import { constantTimeTokenEquals } from './capability.js';
import {
  DAEMON_DEFAULT_IDLE_TIMEOUT_MS,
  DAEMON_ERROR_CODES,
  DAEMON_PROTO,
  drainNdjsonBuffer,
  errorFrame,
  isRequestFrame,
  resultFrame,
  serializeFrame,
  type DaemonRequestFrame,
} from './ndjson.js';
import { daemonPaths } from './paths.js';

export interface DaemonClientInfo {
  readonly kind: string;
  readonly pid?: number;
  readonly version?: string;
}

export interface DaemonServerOptions {
  readonly dataDir: string;
  readonly token: string;
  readonly version: string;
  readonly epoch: number;
  readonly idleTimeoutMs?: number;
  readonly handlers?: Record<
    string,
    (params: unknown, client: DaemonClientInfo) => unknown | Promise<unknown>
  >;
  /** Reported by `daemon.status`; Phase 3 replaces this with the real count. */
  readonly countWorkers?: () => number;
  /** Invoked by `daemon.stop`. Phase 2 has no workers, so `drain` is accepted
   *  and ignored; Phase 3 makes it wait for idleness. */
  readonly onStop?: (options: { drain: boolean }) => Promise<void> | void;
  readonly onReady?: (info: { socketFile: string; socketIsFallback: boolean }) => void;
}

export interface RunningDaemon {
  readonly socketFile: string;
  readonly socketIsFallback: boolean;
  readonly epoch: number;
  /**
   * Pushes a server-initiated frame to every connected client.
   *
   * The agent view's footer badge is specified as a subscription, not a poll
   * (§3.5). A badge that refreshes on an interval is wrong for up to one
   * interval, and the moment it matters is a job parked on a permission
   * question the user is not currently looking at.
   */
  broadcast(method: string, params?: unknown): void;
  /** Connected peers, used by tests and by `daemon.status` diagnostics. */
  subscriberCount(): number;
  stop(): Promise<void>;
}

/**
 * The daemon's listening socket.
 *
 * The socket file is created by `listen`, and the caller is expected to have
 * already proved it is the singleton. That ordering is the guardrail: unlinking
 * a socket you may not own is how a live daemon silently loses its address, so
 * this module unlinks only the file it is about to create, and only after
 * confirming nothing is already listening there.
 */
export async function startDaemonServer(
  options: DaemonServerOptions,
): Promise<RunningDaemon> {
  const paths = daemonPaths(options.dataDir);
  await mkdir(dirname(paths.socketFile), { recursive: true, mode: 0o700 });
  await clearStaleSocket(paths.socketFile);

  const server = createServer({ allowHalfOpen: false });
  const connections = new Set<Socket>();
  let stopping = false;
  const workerCount = options.countWorkers ?? (() => 0);
  const handlers: Record<
    string,
    (
      params: unknown,
      client: DaemonClientInfo,
      defer: (action: () => Promise<void> | void) => void,
    ) => unknown | Promise<unknown>
  > = {
    // Built in, because every client needs it to decide whether the daemon it
    // reached is the one it meant to reach.
    'daemon.status': () => ({
      proto: DAEMON_PROTO,
      daemonVersion: options.version,
      epoch: options.epoch,
      socketFile: paths.socketFile,
      socketIsFallback: paths.socketIsFallback,
      workers: workerCount(),
    }),
    'daemon.stop': async (params, _client, defer) => {
      // Deferred, not immediate: stopping tears down every connection including
      // the one asking, so doing it here would close the socket before the reply
      // was flushed and the caller would see a dropped connection, not a stop.
      defer(async () => {
        await options.onStop?.({ drain: readDrainFlag(params) });
      });
      return { stopped: true };
    },
    ...options.handlers,
  };

  server.on('connection', (socket) => {
    connections.add(socket);
    // A daemon is designed to outlive the terminals that started it, so an idle
    // peer cannot be assumed to be coming back.
    socket.setTimeout(options.idleTimeoutMs ?? DAEMON_DEFAULT_IDLE_TIMEOUT_MS, () => {
      socket.destroy();
    });
    socket.on('close', () => connections.delete(socket));
    attachConnection(socket);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socketFile, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') await chmod(paths.socketFile, 0o600);
  options.onReady?.({ socketFile: paths.socketFile, socketIsFallback: paths.socketIsFallback });

  function attachConnection(socket: Socket): void {
    let buffer = '';
    // The handshake is the security boundary, so state lives per connection and
    // is one-way: a client that misses the first frame stays unauthenticated.
    let client: DaemonClientInfo | undefined;
    let seenAnyFrame = false;
    // "Idle" means no request is being served. `job.send` may start a worker and
    // load its session before it answers, and a timer that fired during that
    // window would drop a peer the daemon was about to answer.
    let serving = 0;
    const idleLimit = options.idleTimeoutMs ?? DAEMON_DEFAULT_IDLE_TIMEOUT_MS;
    const armIdleTimer = (): void => {
      socket.setTimeout(serving > 0 ? 0 : idleLimit, () => socket.destroy());
    };
    armIdleTimer();

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const drained = drainNdjsonBuffer(buffer);
      buffer = drained.rest;
      if (drained.oversized) {
        socket.destroy();
        return;
      }
      for (const frame of drained.frames) {
        if (!isRequestFrame(frame)) {
          send(socket, errorFrame(null, DAEMON_ERROR_CODES.invalidRequest, 'Malformed request.'));
          socket.destroy();
          return;
        }
        const first = !seenAnyFrame;
        seenAnyFrame = true;
        if (first) {
          const handshake = frame as DaemonRequestFrame;
          if (handshake.method !== 'hello') {
            rejectAndDrop(socket, handshake.id, 'The first frame must be a hello handshake.');
            return;
          }
          if (!handshakeAccepted(handshake, options.token)) {
            // One refusal, then the socket closes. The reply carries nothing a
            // caller could use as an oracle beyond "that token is not the one".
            rejectAndDrop(socket, handshake.id, 'Rejected: invalid capability token.');
            return;
          }
          client = readClientInfo(handshake.params);
          send(
            socket,
            resultFrame(handshake.id, {
              proto: DAEMON_PROTO,
              daemonVersion: options.version,
              epoch: options.epoch,
            }),
          );
          continue;
        }
        if (frame.method === 'hello') {
          // Re-handshaking would be a way to re-present a token on a connection
          // that already failed one.
          rejectAndDrop(socket, frame.id, 'This connection has already handshaken.');
          return;
        }
        // Counted here, after the handshake, so the handshake's own `continue`
        // paths cannot leak a count and leave the timer disabled forever.
        serving += 1;
        armIdleTimer();
        void dispatch(socket, frame, client).finally(() => {
          serving = Math.max(0, serving - 1);
          armIdleTimer();
        });
      }
    });
    socket.on('error', () => socket.destroy());
  }

  async function dispatch(
    socket: Socket,
    frame: DaemonRequestFrame,
    client: DaemonClientInfo | undefined,
  ): Promise<void> {
    const handler = handlers[frame.method];
    if (!handler) {
      send(socket, errorFrame(frame.id, DAEMON_ERROR_CODES.methodNotFound, `Unknown method: ${frame.method}`));
      return;
    }
    const deferred: (() => Promise<void> | void)[] = [];
    try {
      const result = await handler(frame.params, client ?? { kind: 'unknown' }, (action) => {
        deferred.push(action);
      });
      await writeThen(socket, serializeFrame(resultFrame(frame.id, result) as never));
    } catch (error) {
      await writeThen(
        socket,
        serializeFrame(
          errorFrame(
            frame.id,
            DAEMON_ERROR_CODES.internal,
            error instanceof Error ? error.message : 'Internal error',
          ) as never,
        ),
      );
    }
    for (const action of deferred) await action();
  }

  return {
    socketFile: paths.socketFile,
    socketIsFallback: paths.socketIsFallback,
    epoch: options.epoch,
    broadcast: (method, params) => {
      // Skips sockets the kernel already knows are gone. Without the guard a
      // push to a TUI that was `kill -9`ed accumulates write callbacks on a
      // dead handle, and the daemon leaks one pending write per broadcast.
      for (const socket of connections) {
        if (socket.destroyed || socket.writableEnded) continue;
        send(socket, { jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
      }
    },
    subscriberCount: () => connections.size,
    stop: async () => {
      if (stopping) return;
      stopping = true;
      for (const socket of connections) socket.destroy();
      connections.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Only ever removes the socket this process created.
      await rm(paths.socketFile, { force: true });
    },
  };
}

function readDrainFlag(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false;
  return (params as { drain?: unknown }).drain === true;
}

function handshakeAccepted(frame: DaemonRequestFrame, token: string): boolean {
  const params = frame.params;
  if (!params || typeof params !== 'object') return false;
  const presented = (params as { token?: unknown }).token;
  return typeof presented === 'string' && constantTimeTokenEquals(presented, token);
}

function readClientInfo(params: unknown): DaemonClientInfo {
  const record = (params ?? {}) as { client?: unknown };
  const client = record.client;
  if (!client || typeof client !== 'object') return { kind: 'unknown' };
  const { kind, pid, version } = client as Record<string, unknown>;
  return {
    kind: typeof kind === 'string' ? kind : 'unknown',
    ...(typeof pid === 'number' ? { pid } : {}),
    ...(typeof version === 'string' ? { version } : {}),
  };
}

function rejectAndDrop(socket: Socket, id: number | string | null, message: string): void {
  // `end`, not `destroy`: destroying here can discard the reply before it is
  // flushed, and a rejection the caller never sees is indistinguishable from a
  // hang. The socket closes on its own once the write drains.
  send(socket, errorFrame(id, DAEMON_ERROR_CODES.unauthorized, message));
  socket.end();
}

function send(socket: Socket, frame: unknown): void {
  void writeThen(socket, serializeFrame(frame as never));
}

/** Resolves once the bytes are handed to the kernel, so callers can act after. */
function writeThen(socket: Socket, chunk: string): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.write(chunk, () => resolve()));
}

/**
 * Removes a socket file only when nothing is listening on it.
 *
 * A `kill -9` leaves the file behind, and the next start has to get past it. But
 * unlinking a socket that a live daemon is serving would make that daemon
 * unreachable rather than replace it, so an active listener is a hard error.
 */
async function clearStaleSocket(socketFile: string): Promise<void> {
  const { connect } = await import('node:net');
  const inUse = await new Promise<boolean>((resolve) => {
    const probe = connect(socketFile);
    const settle = (result: boolean) => {
      probe.destroy();
      resolve(result);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
  });
  if (inUse) {
    throw new Error(`A daemon is already listening on ${socketFile}`);
  }
  await rm(socketFile, { force: true });
}
