import type { LocalPeerMessagingAdapter, LocalPeerSendOutcome, LocalPeerSessionSummary } from '@mavis/agent-tools/desktop';
import type { RuntimeConversation } from '@mavis/conversation-contract';

import {
  listBoundPeerSessions,
  pruneStaleInboxes,
  sendToPeerInbox,
  type PeerMessageEnvelope,
} from '../communication/peer-inbox.js';
import type { LocalSessionListOptions, LocalSessionRecord } from '../sessions/controller.js';

/**
 * §4.2 / §4.4 The agent-facing half of cross-session messaging.
 *
 * The daemon is not in this path. A sending session connects straight to the
 * receiving session's own socket, because the receiving session has to be the
 * one that admits the message: only it knows its own permission mode, and only
 * it can decide whether this sender gets to wake it.
 *
 * Addressing is by the name the user gave a session with /rename, falling back
 * to a session id. A name several running sessions answer to is refused with
 * the candidate ids rather than resolved by guesswork: §4.3 says the address is
 * ambiguous, and picking one would deliver a message into a conversation the
 * sender never meant, with no visible sign that it happened.
 */

export interface PeerMessagingDeps {
  readonly dataDir: string;
  readonly conversation: {
    readonly query: Pick<RuntimeConversation['query'], 'getSession'>;
    readonly ingress: Pick<RuntimeConversation['ingress'], 'submit' | 'abort'>;
  };
  listAllSessions(
    agentName?: string,
    options?: LocalSessionListOptions,
  ): Promise<LocalSessionRecord[]>;
  /** Resolves the name the user gave a session, for the reply address. */
  readSessionName(sessionId: string): Promise<string | undefined>;
  /**
   * How long `sendMessage` waits for the peer's answer before reporting
   * delivery without one. Defaults to the client default.
   */
  readonly replyTimeoutMs?: number;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export function buildPeerMessagingAdapter(deps: PeerMessagingDeps): LocalPeerMessagingAdapter {
  return {
    listPeers: (req) => listPeers(deps, req.selfSessionId),
    sendMessage: (req) => sendMessage(deps, req),
  };
}

/**
 * §4.11 `/list-agents`: the sessions a session can reach.
 *
 * A socket file that exists is a session that is running, which is why the
 * listing is the intersection of "has a socket" and "still exists in the
 * runtime" — a socket whose session was deleted would otherwise advertise a
 * target that answers every message with `Session not found`.
 */
async function listPeers(deps: PeerMessagingDeps, selfSessionId: string): Promise<
  LocalPeerSessionSummary[]
> {
  await pruneStaleInboxes(deps.dataDir);
  const bound = new Set(await listBoundPeerSessions(deps.dataDir));
  if (bound.size === 0) {
    // The caller still appears: it is running, and the first row is the name its
    // peers use to reach it (§4.11), even before any other session is up.
    const self = await describeSession(deps, selfSessionId);
    return self ? [{ ...self, isSelf: true }] : [];
  }
  const summaries: LocalPeerSessionSummary[] = [];
  for (const sessionId of bound) {
    const summary = await describeSession(deps, sessionId);
    if (summary) summaries.push({ ...summary, isSelf: sessionId === selfSessionId });
  }
  summaries.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return (a.name ?? a.sessionId).localeCompare(b.name ?? b.sessionId);
  });
  return summaries;
}

async function describeSession(
  deps: PeerMessagingDeps,
  sessionId: string,
): Promise<LocalPeerSessionSummary | undefined> {
  const session = await deps.conversation.query.getSession(sessionId).catch(() => undefined);
  if (!session) return undefined;
  const workspaceDir = typeof session.workspaceDir === 'string' ? session.workspaceDir : undefined;
  const title = typeof session.title === 'string' ? session.title : undefined;
  const name = title?.trim() || (await deps.readSessionName(sessionId));
  return {
    sessionId,
    ...(name ? { name } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
    isSelf: false,
  };
}

async function sendMessage(
  deps: PeerMessagingDeps,
  req: {
    fromSessionId: string;
    fromName?: string;
    to: string;
    content: string;
    notifyWhenIdle?: boolean;
  },
  signal?: AbortSignal,
): Promise<LocalPeerSendOutcome> {
  await pruneStaleInboxes(deps.dataDir);
  const bound = new Set(await listBoundPeerSessions(deps.dataDir));
  if (bound.size === 0) {
    return {
      delivered: false,
      reason: 'no other session on this machine is running, so there is nobody to message',
    };
  }

  const target = await resolveTarget(deps, req.to, bound);
  if ('error' in target) return target.error;

  const fromName = req.fromName ?? (await deps.readSessionName(req.fromSessionId));
  const envelope: PeerMessageEnvelope = {
    type: 'message',
    fromSessionId: req.fromSessionId,
    ...(fromName ? { fromName } : {}),
    content: req.content,
    ...(req.notifyWhenIdle === true ? { notifyWhenIdle: true } : {}),
  };

  const result = await sendToPeerInbox({
    dataDir: deps.dataDir,
    sessionId: target.sessionId,
    message: envelope,
    ...(deps.replyTimeoutMs !== undefined ? { replyTimeoutMs: deps.replyTimeoutMs } : {}),
    ...(signal ? { signal } : {}),
  });

  if (!result.ok) {
    if (result.detail === 'held') {
      return {
        delivered: false,
        reason: `${target.name ?? target.sessionId} is holding the message for your approval; it was not delivered`,
      };
    }
    if (result.detail === 'refused') {
      return {
        delivered: false,
        reason: `${target.name ?? target.sessionId} refused the message (${result.reason})`,
      };
    }
    if (result.detail === 'delivered-no-reply') {
      // §4.4: delivery is the message reaching the receiving session. Saying so
      // stops the sender from re-sending the same text into a session that has
      // already received it, which is how a message loop starts.
      return {
        delivered: true,
        reply: '',
        targetSessionId: target.sessionId,
        ...(target.name ? { targetName: target.name } : {}),
      };
    }
    return { delivered: false, reason: result.reason };
  }

  return {
    delivered: true,
    reply: result.reply.content,
    targetSessionId: target.sessionId,
    ...(target.name ? { targetName: target.name } : {}),
  };
}

type ResolveResult =
  | { readonly sessionId: string; readonly name?: string }
  | { readonly error: LocalPeerSendOutcome };

/**
 * A session id is accepted verbatim when that session is running. Otherwise the
 * argument is matched against the names of the sessions that are, which is what
 * makes `/rename` the addressing scheme §4.3 describes.
 */
async function resolveTarget(
  deps: PeerMessagingDeps,
  to: string,
  bound: ReadonlySet<string>,
): Promise<ResolveResult> {
  if (SESSION_ID_PATTERN.test(to) && bound.has(to)) {
    const summary = await describeSession(deps, to);
    return summary ? { sessionId: to, ...(summary.name ? { name: summary.name } : {}) } : { sessionId: to };
  }

  const running: Array<{ sessionId: string; name?: string }> = [];
  for (const sessionId of bound) {
    const summary = await describeSession(deps, sessionId);
    if (summary) running.push({ sessionId, ...(summary.name ? { name: summary.name } : {}) });
  }

  const byName = running.filter((peer) => peer.name === to);
  if (byName.length === 1) return byName[0] as { sessionId: string; name?: string };
  if (byName.length > 1) {
    return {
      error: {
        delivered: false,
        reason: `${byName.length} running sessions are named "${to}"`,
        candidates: byName.map((peer) => peer.sessionId),
      },
    };
  }

  // A session id for something that is not running is worth saying plainly: the
  // difference between "no such session" and "it exists but is not up" is what
  // tells the caller whether to wait or to look for a different target.
  const isId = SESSION_ID_PATTERN.test(to);
  if (isId) {
    const exists = await deps.conversation.query.getSession(to).catch(() => undefined);
    if (exists) {
      return {
        error: {
          delivered: false,
          reason: `session ${to} is not running, so it cannot receive messages`,
        },
      };
    }
  }

  const available = running.map((peer) => peer.name ?? peer.sessionId);
  return {
    error: {
      delivered: false,
      reason: `no running session is named "${to}"`,
      ...(available.length > 0 ? { candidates: available } : {}),
    },
  };
}