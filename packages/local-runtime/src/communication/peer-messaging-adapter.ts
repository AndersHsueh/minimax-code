import type { LocalPeerMessagingAdapter, LocalPeerSendOutcome, LocalPeerSessionSummary } from '@mavis/agent-tools/desktop';
import type { RuntimeConversation } from '@mavis/conversation-contract';

import {
  listLiveInboxes,
  sendToPeerInbox,
  type PeerMessageEnvelope,
} from '../communication/peer-inbox.js';

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
  const live = await listLiveInboxes(deps.dataDir);
  if (live.length === 0) {
    // The caller still appears: it is running, and the first row is the name its
    // peers use to reach it (§4.11), even before any other session is up.
    const self = await describeSession(deps, selfSessionId);
    return self ? [{ ...self, isSelf: true }] : [];
  }
  const described = await describeSessions(deps, live);
  const summaries: LocalPeerSessionSummary[] = [];
  for (const [sessionId, summary] of described) {
    if (summary) summaries.push({ ...summary, isSelf: sessionId === selfSessionId });
  }
  summaries.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return (a.name ?? a.sessionId).localeCompare(b.name ?? b.sessionId);
  });
  return summaries;
}

/**
 * Resolves several sessions at once.
 *
 * These are independent reads of the same store, so they run together: N
 * sequential lookups made one tool call scale with the number of sessions the
 * user happens to have open, which is exactly the case where the list is
 * longest.
 */
async function describeSessions(
  deps: PeerMessagingDeps,
  sessionIds: readonly string[],
): Promise<Array<[string, DescribedPeer | undefined]>> {
  return Promise.all(
    sessionIds.map(
      async (sessionId): Promise<[string, DescribedPeer | undefined]> => [
        sessionId,
        await describeSession(deps, sessionId),
      ],
    ),
  );
}

/** A peer as the store describes it; `isSelf` is the caller's judgement, not the store's. */
type DescribedPeer = Omit<LocalPeerSessionSummary, 'isSelf'>;

async function describeSession(
  deps: PeerMessagingDeps,
  sessionId: string,
): Promise<DescribedPeer | undefined> {
  const session = await deps.conversation.query.getSession(sessionId).catch(() => undefined);
  if (!session) return undefined;
  const workspaceDir = typeof session.workspaceDir === 'string' ? session.workspaceDir : undefined;
  const title = typeof session.title === 'string' ? session.title : undefined;
  const name = title?.trim() || undefined;
  return { sessionId, ...(name ? { name } : {}), ...(workspaceDir ? { workspaceDir } : {}) };
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
  const live = await listLiveInboxes(deps.dataDir);
  if (live.length === 0) {
    return {
      delivered: false,
      reason: 'no other session on this machine is running, so there is nobody to message',
    };
  }

  const target = await resolveTarget(deps, req.to, live);
  if ('error' in target) return target.error;

  // §4.3: the message carries the sender's name so the receiving session knows
  // who to reply to. The sender is itself a live inbox, so this is one lookup,
  // not a per-peer cost.
  const fromName = req.fromName ?? (await describeSession(deps, req.fromSessionId))?.name;
  const envelope: PeerMessageEnvelope = {
    type: 'message',
    fromSessionId: req.fromSessionId,
    ...(fromName ? { fromName } : {}),
    content: req.content,
  };

  const result = await sendToPeerInbox({
    dataDir: deps.dataDir,
    sessionId: target.sessionId,
    message: envelope,
    ...(deps.replyTimeoutMs !== undefined ? { replyTimeoutMs: deps.replyTimeoutMs } : {}),
    ...(signal ? { signal } : {}),
  });

  if (!result.ok) {
    if (result.detail === 'refused') {
      return {
        delivered: false,
        reason: `${target.name ?? target.sessionId} did not accept the message: ${result.reason}`,
      };
    }
    if (result.detail === 'throttled') {
      // §4.12: the throttle is the receiving session's rate limit firing, not a
      // decision by the receiving session's user or policy. Say which, so the
      // sender retries with a pause rather than concluding it was rejected.
      return {
        delivered: false,
        reason: `${target.name ?? target.sessionId} ${result.reason}. Wait before sending again.`,
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
  live: readonly string[],
): Promise<ResolveResult> {
  if (SESSION_ID_PATTERN.test(to) && live.includes(to)) {
    const summary = await describeSession(deps, to);
    return summary ? { sessionId: to, ...(summary.name ? { name: summary.name } : {}) } : { sessionId: to };
  }

  const running: Array<{ sessionId: string; name?: string }> = [];
  for (const [sessionId, summary] of await describeSessions(deps, live)) {
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