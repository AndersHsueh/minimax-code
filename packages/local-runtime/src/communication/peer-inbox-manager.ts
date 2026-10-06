import { startSessionPeerInbox, type StartSessionPeerInboxOptions } from './session-peer-inbox.js';
import type { PeerInboxHandle, PeerInboundDecision } from './peer-inbox.js';

/**
 * Binds one inbox per session, once per process.
 *
 * A session's socket is bound the first time that session runs a Turn rather
 * than when the process starts. That is what makes the socket file a truthful
 * roster: the directory holds exactly the sessions that have done something,
 * so a session that was opened and closed never leaves a row that answers
 * `SendMessage` and then admits nobody is there.
 *
 * Binding happens on the turn path, which is also the only place that covers
 * every surface — an interactive TUI, an ACP client, and a daemon worker all
 * run turns, and none of them needs its own registration step.
 */

const handles = new Map<string, PeerInboxHandle>();
const starting = new Map<string, Promise<PeerInboxHandle | undefined>>();

export interface EnsureSessionInboxOptions {
  readonly dataDir: string;
  readonly sessionId: string;
  readonly conversation: StartSessionPeerInboxOptions['conversation'];
  readonly inbound?: PeerInboundDecision;
}

/**
 * Idempotent. Concurrent turns in the same session share one bind attempt, so a
 * session whose first two turns start together does not fight over the same
 * path — the second caller gets the first one's socket.
 *
 * A failure to bind is not fatal. §4.5 is explicit that a session which cannot
 * create an inbox runs without one, showing `unavailable` rather than refusing
 * to start; here it simply does not appear in `ListAgents`, and the Turn that
 * triggered the bind proceeds untouched.
 */
export async function ensureSessionInbox(
  options: EnsureSessionInboxOptions,
): Promise<PeerInboxHandle | undefined> {
  const existing = handles.get(options.sessionId);
  if (existing) return existing;

  const inflight = starting.get(options.sessionId);
  if (inflight) return inflight;

  const attempt = startSessionPeerInbox({
    dataDir: options.dataDir,
    sessionId: options.sessionId,
    conversation: options.conversation,
    ...(options.inbound ? { inbound: options.inbound } : {}),
  })
    .then((handle) => {
      handles.set(options.sessionId, handle);
      return handle;
    })
    .catch(() => undefined)
    .finally(() => {
      starting.delete(options.sessionId);
    });

  starting.set(options.sessionId, attempt);
  return attempt;
}

/** Releases every inbox this process bound. Called on shutdown. */
export async function releaseAllSessionInboxes(): Promise<void> {
  const all = [...handles.values()];
  handles.clear();
  await Promise.all(all.map((handle) => handle.close().catch(() => undefined)));
}

/** The sessions this process is listening for. Used by tests. */
export function boundInboxSessions(): string[] {
  return [...handles.keys()];
}