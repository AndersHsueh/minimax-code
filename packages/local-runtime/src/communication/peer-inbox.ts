import { createHash } from 'node:crypto';
import { existsSync, lstatSync, type Dirent } from 'node:fs';
import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DataDirInput } from '../persistence/db.js';

/**
 * §4.5 The session's inbox socket.
 *
 * One Unix domain socket per session, so a message from another session on this
 * machine never travels through a server: the sending process connects to the
 * receiving session's own socket and the receiving session decides what happens
 * next, with its own permission mode and its own Turn.
 *
 * The socket file *is* the roster. A session that has bound one is reachable;
 * one that has not is invisible to `ListAgents` and cannot be messaged. That
 * removes the need for a registry that could disagree with reality: there is no
 * record to fall out of sync with a process that died.
 *
 * The wire format is one JSON object per line. §4.5 does not publish the
 * serialized message format, so this is our own; it is deliberately the smallest
 * thing that carries the sender's identity and the text, because §4.1 is
 * explicit that a message is plain text and never the sender's history.
 */

export type PeerInboundDecision = 'accept' | 'hold' | 'refuse';

/** What the sending session told the receiving session. */
export interface PeerMessageEnvelope {
  readonly type: 'message';
  readonly fromSessionId: string;
  readonly fromName?: string;
  readonly content: string;
}

export interface PeerInboxAuthLine {
  readonly type: 'auth';
  readonly token: string;
}

export type PeerInboxResponseLine =
  | { readonly type: 'reply'; readonly sessionId: string; readonly content: string }
  | {
      readonly type: 'refused';
      readonly sessionId: string;
      readonly reason: string;
      /** `throttled` = our loop guard dropped it, not a decision the session made. */
      readonly kind?: 'refused' | 'throttled';
    };

/**
 * §4.5: Claude Code closes a connection that has not sent a complete line
 * within 30 seconds.
 *
 * That is a deadline on *emitting the request*, not on the peer's answer. The
 * peer has to start a Turn to produce one, and a Turn that reads files or runs
 * a test routinely runs for minutes — so this is only the connect-and-write
 * window. Conflating the two makes every message to a busy peer fail
 * deterministically at 30 seconds, which is what a peer that is merely working
 * looks like from the outside.
 */
export const PEER_INBOX_LINE_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the peer's reply once the line is out.
 *
 * The peer's answer is a bonus, not the delivery: §4.4 defines delivery as the
 * message reaching the receiving session, and §4.9 is what exists for "tell me
 * when it is done" rather than holding the caller's Turn open for it. A peer
 * that is itself messaging a third session can take many minutes to answer,
 * and a sender blocked that long is worse than one told the message landed and
 * the reply is still coming.
 */
export const PEER_INBOX_REPLY_TIMEOUT_MS = 2 * 60_000;

export interface PeerInboxPaths {
  readonly inboxDir: string;
  readonly socketPath: string;
}

/**
 * Where inbox sockets live, shortest name first, each candidate within the
 * `sun_path` budget.
 *
 * One function owns this list because binding and scanning must agree on it: a
 * directory the binder writes into but the scanner never reads produces a
 * session that is running yet invisible to `ListAgents` and unreachable by name,
 * which is the exact failure this list exists to prevent.
 */
function inboxDirCandidates(dataDir: DataDirInput): string[] {
  const dir = typeof dataDir === 'function' ? dataDir() : dataDir;
  return [
    // §4.5: the session's own dataDir first, so an isolated dataDir keeps its
    // sessions isolated from another dataDir's. Then a short per-user directory,
    // with `/tmp` ahead of the platform temp directory because macOS hands out a
    // `/var/folders/...` path long enough to push a normal session id past the
    // limit on its own.
    join(dir, 'run', 'inbox'),
    join('/tmp', `mcode-inbox-${currentUid()}`),
    join(tmpdir(), `mcode-inbox-${currentUid()}`),
  ];
}

/**
 * Every path is derived from `dataDir`, never from home. §4.10 separates same-
 * machine messaging from cross-machine routing, and an isolated dataDir is a
 * legitimate way to keep two sets of sessions from reaching each other, so the
 * inbox directory has to follow the dataDir that created the session.
 */
export function peerInboxPaths(dataDir: DataDirInput, sessionId: string): PeerInboxPaths {
  const limit = sunPathLimit();
  const name = `${sessionId}.sock`;
  for (const inboxDir of inboxDirCandidates(dataDir)) {
    const socketPath = join(inboxDir, name);
    if (Buffer.byteLength(socketPath) < limit) return { inboxDir, socketPath };
  }
  // Neither short directory fits a session id this long. The socket still binds,
  // but under a name that cannot be read back as a session id, so the session is
  // reachable by id and absent from `ListAgents`.
  const digest = createHash('sha256')
    .update(`${String(typeof dataDir === 'function' ? dataDir() : dataDir)}\u0000${sessionId}`)
    .digest('hex')
    .slice(0, 24);
  const inboxDir = join('/tmp', `mcode-inbox-${currentUid()}`);
  return { inboxDir, socketPath: join(inboxDir, `${digest}.sock`) };
}

/**
 * The sessions that can actually receive a message right now.
 *
 * A socket file outlives the process that bound it whenever that process dies
 * without closing: a killed worker, a closed terminal, a crash. §4.11 says a
 * session appears only while it can receive messages, so a leftover file would
 * advertise a target that accepts a connection and then answers with
 * ECONNREFUSED — a ghost in the roster that looks exactly like a live session.
 * Those are deleted here rather than listed and then failed against.
 *
 * Probing is a connect attempt with no data written, so a live session is left
 * untouched: it sees a connection that closes without saying anything, which its
 * own line reader discards as an empty line.
 *
 * Scanning and pruning are one pass on purpose — the caller needs the survivors,
 * and a second directory read to collect what the first one already saw is the
 * common case rather than a rare one.
 */
export async function listLiveInboxes(dataDir: DataDirInput): Promise<string[]> {
  const alive: string[] = [];
  const sockets = await scanInboxSockets(dataDir);
  const live = await Promise.all(sockets.map((entry) => isSocketLive(entry.path)));
  for (const [index, entry] of sockets.entries()) {
    if (live[index]) {
      alive.push(entry.sessionId);
      continue;
    }
    await rm(entry.path, { force: true }).catch(() => undefined);
  }
  return alive;
}

function scanInboxSockets(dataDir: DataDirInput): Promise<Array<{ sessionId: string; path: string }>> {
  // The same candidate list the binder walks, so a session that bound into a
  // fallback directory is found here too.
  return Promise.all(inboxDirCandidates(dataDir).map(scanInboxDirectory)).then((scanned) => {
    const found = new Map<string, string>();
    for (const entries of scanned) {
      for (const { entry, path } of entries) {
        if (!entry.isFile() && !entry.isSocket()) continue;
        const match = /^([A-Za-z0-9_-]+)\.sock$/.exec(entry.name);
        if (match) found.set(match[1] as string, path);
      }
    }
    return [...found].map(([sessionId, path]) => ({ sessionId, path }));
  });
}

async function scanInboxDirectory(
  dir: string,
): Promise<Array<{ entry: Dirent; path: string }>> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({ entry, path: join(dir, entry.name) }));
  } catch {
    return [];
  }
}

function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let done = false;
    const settle = (alive: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(alive);
    };
    // A dead socket refuses immediately; the timer only bounds a path that
    // accepts the connection and then never completes it.
    const timer = setTimeout(() => settle(false), 1_000);
    timer.unref?.();
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

export interface PeerInboxServerOptions {
  readonly dataDir: DataDirInput;
  readonly sessionId: string;
  /**
   * §4.5 exports a per-session token as `CLAUDE_CODE_MESSAGING_TOKEN`. On
   * macOS and Linux the auth line is optional, so it authenticates a connection
   * when one offers it rather than being required to get one.
   */
  readonly token?: string;
  /**
   * Hands the message to the receiving session.
   *
   * Returning a string is the session's reply, which travels back over the same
   * connection: §4.9 makes the sender reachable again, and a caller that cannot
   * see what the other session said has to poll for it.
   */
  /**
   * Hands the message to the receiving session.
   *
   * `signal` aborts when the peer goes away. Delivery can take minutes while a
   * Turn is in flight, and without this the server would keep waiting — and
   * could still start a Turn whose reply has nobody left to read it.
   */
  readonly deliver: (message: PeerMessageEnvelope, signal: AbortSignal) => Promise<string>;
}

export interface PeerInboxHandle {
  readonly socketPath: string;
  readonly inboxDir: string;
  close(): Promise<void>;
}

/**
 * Binds this session's inbox and serves messages until closed.
 *
 * The directory is created 0700 and the socket 0600 so another OS user cannot
 * deliver into this session (§4.5). A directory that already exists but is not
 * ours is refused rather than reused: binding a socket into a directory another
 * user owns would let them replace the file between our bind and our connect.
 */
export async function startPeerInbox(options: PeerInboxServerOptions): Promise<PeerInboxHandle> {
  const paths = peerInboxPaths(options.dataDir, options.sessionId);
  await ensureInboxDirectory(paths.inboxDir);
  await removeStaleSocket(paths.socketPath);

  const server = createServer({ allowHalfOpen: false });
  let closing = false;

  server.on('connection', (socket: Socket) => {
    void serveConnection(socket, options);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(paths.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') await chmod(paths.socketPath, 0o600);

  return {
    socketPath: paths.socketPath,
    inboxDir: paths.inboxDir,
    close: async () => {
      if (closing) return;
      closing = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(paths.socketPath, { force: true }).catch(() => undefined);
    },
  };
}

async function serveConnection(socket: Socket, options: PeerInboxServerOptions): Promise<void> {
  const lines = readLines(socket);
  let authenticated = !options.token;
  let handled = false;

  const finish = async (line: PeerInboxResponseLine) => {
    if (handled) return;
    handled = true;
    socket.end(`${JSON.stringify(line)}\n`);
  };

  const gone = new AbortController();
  socket.once('close', () => gone.abort());
  socket.once('error', () => gone.abort());

  try {
    for await (const raw of lines) {
      const parsed = parseJson(raw);
      if (!parsed) {
        await finish({ type: 'refused', sessionId: options.sessionId, reason: 'malformed-line' });
        return;
      }
      if (parsed.type === 'auth') {
        if (options.token && parsed.token !== options.token) {
          await finish({ type: 'refused', sessionId: options.sessionId, reason: 'invalid-token' });
          return;
        }
        authenticated = true;
        continue;
      }
      if (parsed.type !== 'message') {
        await finish({ type: 'refused', sessionId: options.sessionId, reason: 'unsupported-request' });
        return;
      }
      // A token, when the session has one, is the only proof on macOS that the
      // poster is this session's own child (§4.5 own-child rule). Without it the
      // message is treated as an ordinary peer message and the inbound rules
      // decide, which is the documented fallback.
      const envelope: PeerMessageEnvelope = {
        type: 'message',
        fromSessionId: typeof parsed.fromSessionId === 'string' ? parsed.fromSessionId : 'unknown',
        ...(typeof parsed.fromName === 'string' ? { fromName: parsed.fromName } : {}),
        content: typeof parsed.content === 'string' ? parsed.content : '',
      };
      if (options.token && !authenticated) {
        await finish({
          type: 'refused',
          sessionId: options.sessionId,
          reason: 'auth-required',
        });
        return;
      }
      try {
        const content = await options.deliver(envelope, gone.signal);
        await finish({ type: 'reply', sessionId: options.sessionId, content });
      } catch (error) {
        const kind = (error as { kind?: unknown } | undefined)?.kind;
        await finish({
          type: 'refused',
          sessionId: options.sessionId,
          reason: error instanceof Error ? error.message : String(error),
          ...(kind === 'throttled' ? { kind } : {}),
        });
      }
      return;
    }
  } catch {
    // The peer disconnected mid-line. Nothing was delivered, and the caller
    // sees its own timeout; there is no state here worth cleaning up.
  } finally {
    socket.destroy();
  }
}

export interface PeerSendOptions {
  readonly dataDir: DataDirInput;
  readonly sessionId: string;
  readonly token?: string;
  readonly message: PeerMessageEnvelope;
  /** Deadline for connecting and writing the request line. Defaults to 30s (§4.5). */
  readonly timeoutMs?: number;
  /**
   * How long to wait for the peer's reply after the line is out.
   *
   * Separate from {@link timeoutMs} on purpose: the peer runs a whole Turn to
   * answer, so bounding that wait by the protocol's line deadline fails every
   * message to any peer doing real work.
   */
  readonly replyTimeoutMs?: number;
  /**
   * Aborting the caller's Turn must release this connection rather than leave
   * it waiting out the line deadline: the message was part of a Turn that no
   * longer exists, and a reply that arrives after that is nobody's to read.
   */
  readonly signal?: AbortSignal;
}

export type PeerSendResult =
  | { readonly ok: true; readonly reply: Extract<PeerInboxResponseLine, { type: 'reply' }> }
  /**
   * `delivered: true` with no reply is not a failure: §4.4 defines delivery as
   * the message reaching the receiving session. The sender is told plainly that
   * it landed and that the answer is still pending, rather than being made to
   * guess from a timeout that reads like a broken peer.
   */
  | {
      readonly ok: false;
      readonly reason: string;
      readonly detail?: 'refused' | 'throttled' | 'delivered-no-reply';
    };

/**
 * Delivers one message to a peer session and waits for its reply.
 *
 * This is the client half of §4.5. It refuses rather than guesses: a session
 * whose socket is absent is a session that is not running, and a message that
 * silently vanished would leave the sender believing it was delivered.
 */
export async function sendToPeerInbox(options: PeerSendOptions): Promise<PeerSendResult> {
  const paths = peerInboxPaths(options.dataDir, options.sessionId);
  const lineTimeoutMs = options.timeoutMs ?? PEER_INBOX_LINE_TIMEOUT_MS;
  const replyTimeoutMs = options.replyTimeoutMs ?? PEER_INBOX_REPLY_TIMEOUT_MS;

  return new Promise<PeerSendResult>((resolve) => {
    let settled = false;
    const socket = createConnection(paths.socketPath);
    let buffer = '';

    const finish = (result: PeerSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(lineTimer);
      clearTimeout(replyTimer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(result);
    };

    const onAbort = () => finish({ ok: false, reason: 'caller-aborted' });

    // Two deadlines, switched at the moment the request is on the wire: the
    // first bounds only connect-and-write, the second bounds the peer's Turn.
    const lineTimer = setTimeout(() => {
      finish({ ok: false, reason: 'peer-timeout: peer did not accept the connection' });
    }, lineTimeoutMs);
    lineTimer.unref?.();

    let replyTimer: NodeJS.Timeout = setTimeout(() => undefined, 0);
    replyTimer.unref?.();

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        reason:
          error.code === 'ENOENT'
            ? 'no-inbox: that session is not running'
            : (error.message ?? 'socket-error'),
      });
    });
    socket.on('close', () => {
      finish({ ok: false, reason: 'peer-closed-without-reply' });
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const raw = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (raw) {
          const parsed = parseJson(raw);
          if (!parsed) {
            finish({ ok: false, reason: 'malformed-reply' });
            return;
          }
          if (parsed.type === 'reply') {
            finish({
              ok: true,
              reply: {
                type: 'reply',
                sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
                content: typeof parsed.content === 'string' ? parsed.content : '',
              },
            });
            return;
          }
          finish({
            ok: false,
            reason: typeof parsed.reason === 'string' ? parsed.reason : 'refused',
            detail: parsed.kind === 'throttled' ? 'throttled' : 'refused',
          });
          return;
        }
        index = buffer.indexOf('\n');
      }
    });

    socket.on('connect', () => {
      // §4.5: the auth line is optional on macOS and Linux. It is sent when the
      // caller knows the token, and its absence is not an error.
      if (options.token) socket.write(`${JSON.stringify({ type: 'auth', token: options.token })}\n`);
      socket.write(`${JSON.stringify(options.message)}\n`);
      // The request is out; from here the wait belongs to the peer's Turn.
      clearTimeout(lineTimer);
      replyTimer = setTimeout(() => {
        finish({
          ok: false,
          reason:
            'delivered, but the session has not answered yet: it is still working on it or on something else. Its reply will appear in that session.',
          detail: 'delivered-no-reply',
        });
      }, replyTimeoutMs);
      replyTimer.unref?.();
    });
  });
}

async function ensureInboxDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  // A socket left by a process that died has no listener; binding over it would
  // fail with EADDRINUSE. Removing it first is safe precisely because nothing
  // is listening: a live session would still hold its own socket open.
  if (!existsSync(socketPath)) return;
  try {
    const stat = lstatSync(socketPath);
    if (!stat.isSocket()) return;
  } catch {
    return;
  }
  await rm(socketPath, { force: true }).catch(() => undefined);
}

async function* readLines(socket: Socket): AsyncGenerator<string> {
  let buffer = '';
  for await (const chunk of socket) {
    buffer += (chunk as Buffer).toString('utf8');
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) yield line;
      index = buffer.indexOf('\n');
    }
  }
  const tail = buffer.trim();
  if (tail) yield tail;
}

function parseJson(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function sunPathLimit(): number {
  return process.platform === 'darwin' ? 104 : 108;
}

function currentUid(): number | string {
  return typeof process.getuid === 'function' ? process.getuid() : 'uid';
}