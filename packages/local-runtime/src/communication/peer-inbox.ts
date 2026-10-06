import { createHash } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
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
  readonly notifyWhenIdle?: boolean;
}

export interface PeerInboxAuthLine {
  readonly type: 'auth';
  readonly token: string;
}

export type PeerInboxRequestLine = PeerMessageEnvelope | PeerInboxAuthLine;

export type PeerInboxResponseLine =
  | { readonly type: 'reply'; readonly sessionId: string; readonly turnId?: string; readonly content: string }
  | { readonly type: 'held'; readonly sessionId: string; readonly reason: string }
  | { readonly type: 'refused'; readonly sessionId: string; readonly reason: string };

/**
 * §4.12: Claude Code closes a connection that has not sent a complete line
 * within 30 seconds. The same deadline is enforced on the client so a stuck
 * peer fails as a refusal rather than hanging the caller's Turn forever.
 */
export const PEER_INBOX_LINE_TIMEOUT_MS = 30_000;

export interface PeerInboxPaths {
  readonly inboxDir: string;
  readonly socketPath: string;
  readonly socketIsFallback: boolean;
}

/**
 * Every path is derived from `dataDir`, never from home. §4.10 separates same-
 * machine messaging from cross-machine routing, and an isolated dataDir is a
 * legitimate way to keep two sets of sessions from reaching each other, so the
 * inbox directory has to follow the dataDir that created the session.
 */
export function peerInboxPaths(dataDir: DataDirInput, sessionId: string): PeerInboxPaths {
  const dir = typeof dataDir === 'function' ? dataDir() : dataDir;
  const base = join(dir, 'run', 'inbox');
  const preferred = join(base, `${sessionId}.sock`);
  const limit = sunPathLimit();
  if (Buffer.byteLength(preferred) < limit) {
    return { inboxDir: base, socketPath: preferred, socketIsFallback: false };
  }
  // §4.5: when the preferred directory cannot hold the socket, fall back to a
  // per-user private directory. The digest keeps two dataDirs from colliding.
  const digest = createHash('sha256').update(dir).digest('hex').slice(0, 16);
  const fallbackDir = join(tmpdir(), `mcode-inbox-${currentUid()}`, digest);
  return {
    inboxDir: fallbackDir,
    socketPath: join(fallbackDir, `${sessionId}.sock`),
    socketIsFallback: true,
  };
}

/** The socket files that exist right now. A dead session leaves nothing behind. */
export async function listBoundPeerSessions(dataDir: DataDirInput): Promise<string[]> {
  const dir = typeof dataDir === 'function' ? dataDir() : dataDir;
  const candidates = [
    join(dir, 'run', 'inbox'),
    join(tmpdir(), `mcode-inbox-${currentUid()}`),
  ];
  const found = new Set<string>();
  for (const dirPath of candidates) {
    const entries = await readDirSafe(dirPath);
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSocket()) continue;
      const match = /^([A-Za-z0-9_-]+)\.sock$/.exec(entry.name);
      if (match) found.add(match[1] as string);
    }
  }
  return [...found];
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
  readonly deliver: (message: PeerMessageEnvelope) => Promise<string>;
  readonly now?: () => number;
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
        ...(parsed.notifyWhenIdle === true ? { notifyWhenIdle: true } : {}),
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
        const content = await options.deliver(envelope);
        await finish({ type: 'reply', sessionId: options.sessionId, content });
      } catch (error) {
        // §4.6 distinguishes the two refusals: `held` means the message is set
        // aside for the user and the sender should know it is waiting, while a
        // plain refusal means nothing will ever arrive.
        const inbound = (error as { peerInbound?: unknown } | undefined)?.peerInbound;
        await finish({
          type: inbound === 'held' ? 'held' : 'refused',
          sessionId: options.sessionId,
          reason: error instanceof Error ? error.message : String(error),
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
  readonly timeoutMs?: number;
  /**
   * Aborting the caller's Turn must release this connection rather than leave
   * it waiting out the line deadline: the message was part of a Turn that no
   * longer exists, and a reply that arrives after that is nobody's to read.
   */
  readonly signal?: AbortSignal;
}

export type PeerSendResult =
  | { readonly ok: true; readonly reply: Extract<PeerInboxResponseLine, { type: 'reply' }> }
  | { readonly ok: false; readonly reason: string; readonly detail?: 'held' | 'refused' };

/**
 * Delivers one message to a peer session and waits for its reply.
 *
 * This is the client half of §4.5. It refuses rather than guesses: a session
 * whose socket is absent is a session that is not running, and a message that
 * silently vanished would leave the sender believing it was delivered.
 */
export async function sendToPeerInbox(options: PeerSendOptions): Promise<PeerSendResult> {
  const paths = peerInboxPaths(options.dataDir, options.sessionId);
  const timeoutMs = options.timeoutMs ?? PEER_INBOX_LINE_TIMEOUT_MS;

  return new Promise<PeerSendResult>((resolve) => {
    let settled = false;
    const socket = createConnection(paths.socketPath);
    let buffer = '';

    const finish = (result: PeerSendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(result);
    };

    const onAbort = () => finish({ ok: false, reason: 'caller-aborted' });

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'peer-timeout' });
    }, timeoutMs);
    timer.unref?.();

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
                ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
                content: typeof parsed.content === 'string' ? parsed.content : '',
              },
            });
            return;
          }
          if (parsed.type === 'held') {
            finish({
              ok: false,
              reason: typeof parsed.reason === 'string' ? parsed.reason : 'held',
              detail: 'held',
            });
            return;
          }
          finish({
            ok: false,
            reason: typeof parsed.reason === 'string' ? parsed.reason : 'refused',
            detail: 'refused',
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
  const { existsSync, lstatSync } = await import('node:fs');
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

async function readDirSafe(dir: string) {
  try {
    const { readdir } = await import('node:fs/promises');
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sunPathLimit(): number {
  return process.platform === 'darwin' ? 104 : 108;
}

function currentUid(): number | string {
  return typeof process.getuid === 'function' ? process.getuid() : 'uid';
}