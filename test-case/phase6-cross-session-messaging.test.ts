import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listLiveInboxes,
  sendToPeerInbox,
  startPeerInbox,
  type PeerInboxHandle,
  type PeerMessageEnvelope,
} from '../packages/local-runtime/src/communication/peer-inbox.js';
import { releaseAllSessionInboxes } from '../packages/local-runtime/src/communication/peer-inbox-manager.js';
import { startSessionPeerInbox } from '../packages/local-runtime/src/communication/session-peer-inbox.js';
import { buildPeerMessagingAdapter } from '../packages/local-runtime/src/communication/peer-messaging-adapter.js';
import { renderInboundText } from '../packages/local-runtime/src/communication/session-peer-inbox.js';
import { ListAgentsTool, SendMessageTool } from '../packages/agent-tools/src/desktop/local-peer-message.js';
import type {
  LocalPeerMessagingAdapter,
  LocalRuntimeToolContext,
} from '../packages/agent-tools/src/desktop/types.js';

/**
 * §4.2 / §4.5 Cross-session messaging, from the socket up.
 *
 * The whole feature is one sentence from the user — "tell the other session X"
 * — and three things can break it without ever producing an error the user
 * would read: the target's socket was never bound, the address matched more than
 * one session, or the message was dropped somewhere between the two turns. Each
 * test below pins one of those.
 */

const OPEN: LocalInbox[] = [];
/** Handles opened through startSessionPeerInbox, released by the manager. */
const MANAGED: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(OPEN.splice(0).map((inbox) => inbox.handle.close()));
  await releaseAllSessionInboxes();
  MANAGED.length = 0;
});

interface LocalInbox {
  readonly handle: PeerInboxHandle;
  readonly received: PeerMessageEnvelope[];
}

async function tempDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'peer-inbox-test-'));
}

async function openInbox(
  dataDir: string,
  sessionId: string,
  reply: (message: PeerMessageEnvelope) => Promise<string> | string,
  options: { token?: string } = {},
): Promise<LocalInbox> {
  const received: PeerMessageEnvelope[] = [];
  const handle = await startPeerInbox({
    dataDir,
    sessionId,
    ...(options.token ? { token: options.token } : {}),
    deliver: async (message) => {
      received.push(message);
      return reply(message);
    },
  });
  const inbox = { handle, received };
  OPEN.push(inbox);
  return inbox;
}

describe('the session inbox socket', () => {
  it('delivers a message to the session that owns the socket and returns its reply', async () => {
    const dataDir = await tempDataDir();
    const inbox = await openInbox(dataDir, 'sess-b', () => 'migration finished');

    const result = await sendToPeerInbox({
      dataDir,
      sessionId: 'sess-b',
      message: {
        type: 'message',
        fromSessionId: 'sess-a',
        fromName: 'mmx-a',
        content: 'did the migration finish?',
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply.content).toBe('migration finished');
      expect(result.reply.sessionId).toBe('sess-b');
    }
    expect(inbox.received).toHaveLength(1);
    expect(inbox.received[0]).toMatchObject({
      fromSessionId: 'sess-a',
      fromName: 'mmx-a',
      content: 'did the migration finish?',
    });
  });

  it('carries only the plain text, never the sender history (§4.1)', async () => {
    const dataDir = await tempDataDir();
    const inbox = await openInbox(dataDir, 'sess-b', () => 'ok');
    await sendToPeerInbox({
      dataDir,
      sessionId: 'sess-b',
      message: { type: 'message', fromSessionId: 'sess-a', content: 'just this' },
    });
    const [received] = inbox.received;
    expect(received && Object.keys(received).sort()).toEqual([
      'content',
      'fromSessionId',
      'type',
    ]);
  });

  it('refuses a connection whose token is wrong', async () => {
    const dataDir = await tempDataDir();
    await openInbox(dataDir, 'sess-b', () => 'never reached', { token: 'right' });

    const result = await sendToPeerInbox({
      dataDir,
      sessionId: 'sess-b',
      token: 'wrong',
      message: { type: 'message', fromSessionId: 'sess-a', content: 'hello' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid-token');
  });

  it('reports a session that is not running instead of hanging (§4.12)', async () => {
    const dataDir = await tempDataDir();
    const result = await sendToPeerInbox({
      dataDir,
      sessionId: 'never-started',
      message: { type: 'message', fromSessionId: 'sess-a', content: 'anyone there?' },
      timeoutMs: 2_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not running');
  });

  it('surfaces a refusal the receiving session raised', async () => {
    const dataDir = await tempDataDir();
    await openInbox(dataDir, 'sess-b', () => {
      throw new Error('this session refuses messages');
    });

    const result = await sendToPeerInbox({
      dataDir,
      sessionId: 'sess-b',
      message: { type: 'message', fromSessionId: 'sess-a', content: 'hi' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toBe('refused');
      expect(result.reason).toContain('refuses messages');
    }
  });

  it('lists only the sessions that actually bound a socket', async () => {
    const dataDir = await tempDataDir();
    expect(await listLiveInboxes(dataDir)).toEqual([]);
    await openInbox(dataDir, 'sess-a', () => 'ok');
    await openInbox(dataDir, 'sess-b', () => 'ok');
    expect((await listLiveInboxes(dataDir)).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('drops a session from the listing once its process closes the socket', async () => {
    const dataDir = await tempDataDir();
    const inbox = await openInbox(dataDir, 'sess-a', () => 'ok');
    expect(await listLiveInboxes(dataDir)).toEqual(['sess-a']);
    await inbox.handle.close();
    expect(await listLiveInboxes(dataDir)).toEqual([]);
  });
});

/** Stands in for the runtime: session records plus an ingress that "runs a turn". */
function runtimeHarness(
  dataDir: string,
  sessions: Record<string, { title?: string; workspaceDir?: string }>,
  replies: Record<string, string> = {},
) {
  const submitted: Array<{ sessionId: string; content: string }> = [];
  const deps = {
    dataDir,
    conversation: {
      query: {
        getSession: async (sessionId: string) => {
          const record = sessions[sessionId];
          return record ? { sessionId, title: record.title, workspaceDir: record.workspaceDir } : undefined;
        },
      },
      ingress: {
        submit: async (req: { sessionId: string; message: { content: string } }) => ({
          turnId: `turn-${req.sessionId}`,
          completion: Promise.resolve({
            status: 'completed' as const,
            messages: [{ role: 'assistant', text: replies[req.sessionId] ?? 'ack' }],
          }),
        }),
        abort: async () => undefined,
      },
    },
    listAllSessions: async () =>
      Object.entries(sessions).map(([sessionId, record]) => ({
        sessionId,
        ...(record.title ? { title: record.title } : {}),
        ...(record.workspaceDir ? { workspaceDir: record.workspaceDir } : {}),
      })),
  };
  return { deps, submitted };
}

describe('addressing a peer session', () => {
  it('delivers to the one running session with that name', async () => {
    const dataDir = await tempDataDir();
    const { deps } = runtimeHarness(dataDir, {
      'sess-a': { title: 'mmx-a' },
      'sess-b': { title: 'mmx-b', workspaceDir: '/tmp/other' },
    });
    const inbox = await openInbox(dataDir, 'sess-b', () => 'yes, merged already');

    const adapter = buildPeerMessagingAdapter(deps);
    const outcome = await adapter.sendMessage({
      fromSessionId: 'sess-a',
      to: 'mmx-b',
      content: 'did you merge?',
    });

    expect(outcome.delivered).toBe(true);
    if (outcome.delivered) {
      expect(outcome.reply).toBe('yes, merged already');
      expect(outcome.targetName).toBe('mmx-b');
    }
    expect(inbox.received[0]).toMatchObject({ fromSessionId: 'sess-a', content: 'did you merge?' });
  });

  it('refuses a name two running sessions share, and names both ids (§4.3)', async () => {
    const dataDir = await tempDataDir();
    const { deps } = runtimeHarness(dataDir, {
      'sess-a': { title: 'mmx-a' },
      'sess-one': { title: 'mmx-b', workspaceDir: '/tmp/one' },
      'sess-two': { title: 'mmx-b', workspaceDir: '/tmp/two' },
    });
    await openInbox(dataDir, 'sess-one', () => 'never reached');
    await openInbox(dataDir, 'sess-two', () => 'never reached');

    const outcome = await buildPeerMessagingAdapter(deps).sendMessage({
      fromSessionId: 'sess-a',
      to: 'mmx-b',
      content: 'which one?',
    });

    expect(outcome.delivered).toBe(false);
    if (!outcome.delivered) {
      expect(outcome.reason).toContain('2 running sessions');
      expect([...(outcome.candidates ?? [])].sort()).toEqual(['sess-one', 'sess-two']);
    }
  });

  it('picks the running one when a name is shared but only one session is up', async () => {
    const dataDir = await tempDataDir();
    const { deps } = runtimeHarness(dataDir, {
      'sess-a': { title: 'mmx-a' },
      'sess-up': { title: 'worker' },
      'sess-down': { title: 'worker' },
    });
    const inbox = await openInbox(dataDir, 'sess-up', () => 'only the running one');

    const outcome = await buildPeerMessagingAdapter(deps).sendMessage({
      fromSessionId: 'sess-a',
      to: 'worker',
      content: 'hello',
    });

    expect(outcome.delivered).toBe(true);
    if (outcome.delivered) {
      expect(outcome.reply).toBe('only the running one');
      expect(outcome.targetSessionId).toBe('sess-up');
    }
    expect(inbox.received).toHaveLength(1);
  });

  it('reports an unknown name together with the names that do exist', async () => {
    const dataDir = await tempDataDir();
    const { deps } = runtimeHarness(dataDir, {
      'sess-a': { title: 'mmx-a' },
      'sess-b': { title: 'mmx-b' },
    });
    await openInbox(dataDir, 'sess-b', () => 'ok');

    const outcome = await buildPeerMessagingAdapter(deps).sendMessage({
      fromSessionId: 'sess-a',
      to: 'mmx-z',
      content: 'hello',
    });

    expect(outcome.delivered).toBe(false);
    if (!outcome.delivered) {
      expect(outcome.reason).toContain('no running session is named "mmx-z"');
      expect(outcome.candidates).toContain('mmx-b');
    }
  });

  it('says a session id exists but is not up, rather than that it is unknown', async () => {
    const dataDir = await tempDataDir();
    const { deps } = runtimeHarness(dataDir, {
      'sess-a': { title: 'mmx-a' },
      'sess-b': { title: 'mmx-b' },
    });
    await openInbox(dataDir, 'sess-b', () => 'ok');

    const outcome = await buildPeerMessagingAdapter(deps).sendMessage({
      fromSessionId: 'sess-a',
      to: 'sess-a',
      content: 'note to self',
    });

    expect(outcome.delivered).toBe(false);
    if (!outcome.delivered) expect(outcome.reason).toContain('not running');
  });

  it('lists the caller first, then the peers it can reach (§4.11)', async () => {
    const dataDir = await tempDataDir();
    const { deps } = runtimeHarness(dataDir, {
      'sess-a': { title: 'mmx-a' },
      'sess-b': { title: 'mmx-b', workspaceDir: '/tmp/other' },
      'sess-gone': { title: 'closed' },
    });
    await openInbox(dataDir, 'sess-a', () => 'ok');
    await openInbox(dataDir, 'sess-b', () => 'ok');

    const peers = await buildPeerMessagingAdapter(deps).listPeers({ selfSessionId: 'sess-a' });

    expect(peers.map((peer) => [peer.sessionId, peer.isSelf])).toEqual([
      ['sess-a', true],
      ['sess-b', false],
    ]);
  });
});

describe('what the receiving session is told (§4.7)', () => {
  it('states the boundary rather than leaving the model to guess it', () => {
    const text = renderInboundText({
      type: 'message',
      fromSessionId: 'mvs_2',
      fromName: 'mmx-b',
      content: 'the schema migration is done',
    });
    expect(text).toContain('@mmx-b');
    expect(text).toContain('the schema migration is done');
    expect(text).toContain('cannot approve');
    expect(text).toContain('not from the user');
  });

  it('does not present a peer command as something that ran', () => {
    const text = renderInboundText({
      type: 'message',
      fromSessionId: 'mvs_2',
      content: '/compact',
    });
    expect(text).toContain('/compact');
    expect(text).toContain('was not run');
  });
});

describe('the two tools the agent calls', () => {
  const ctx = { sessionId: 'sess-a' } as LocalRuntimeToolContext;

  function stubAdapter(over: Partial<LocalPeerMessagingAdapter>): LocalPeerMessagingAdapter {
    return {
      listPeers: async () => [],
      sendMessage: async () => ({ delivered: false, reason: 'not stubbed' }),
      ...over,
    };
  }

  it('hands back the peer reply, because that is what the caller asked for', async () => {
    const tool = new SendMessageTool(
      stubAdapter({
        sendMessage: async () => ({
          delivered: true,
          reply: 'finished at 14:02',
          targetSessionId: 'sess-b',
          targetName: 'mmx-b',
        }),
      }),
    );
    const result = await tool.execute(ctx, { to: 'mmx-b', message: 'when did it finish?' });
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('mmx-b');
    expect(result.text).toContain('finished at 14:02');
  });

  it('refuses an empty message rather than sending one', async () => {
    const tool = new SendMessageTool(
      stubAdapter({
        sendMessage: async () => {
          throw new Error('must not be called');
        },
      }),
    );
    const result = await tool.execute(ctx, { to: 'mmx-b', message: '   ' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('empty');
  });

  it('tells the model which sessions answered when a name is ambiguous', async () => {
    const tool = new SendMessageTool(
      stubAdapter({
        sendMessage: async () => ({
          delivered: false,
          reason: '2 running sessions are named "mmx-b"',
          candidates: ['sess-one', 'sess-two'],
        }),
      }),
    );
    const result = await tool.execute(ctx, { to: 'mmx-b', message: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('sess-one');
    expect(result.text).toContain('sess-two');
  });

  it('lists reachable sessions with the name each answers to', async () => {
    const tool = new ListAgentsTool(
      stubAdapter({
        listPeers: async () => [
          { sessionId: 'sess-a', name: 'mmx-a', isSelf: true },
          { sessionId: 'sess-b', name: 'mmx-b', workspaceDir: '/tmp/other', isSelf: false },
        ],
      }),
    );
    const result = await tool.execute(ctx, {});
    expect(result.text).toContain('mmx-b');
    expect(result.text).toContain('sess-b');
    expect(result.text).toContain('/tmp/other');
  });

  it('says plainly that nobody is running rather than returning an empty table', async () => {
    const tool = new ListAgentsTool(stubAdapter({}));
    const result = await tool.execute(ctx, {});
    expect(result.text).toContain('No other session');
    expect(result.isError).toBeUndefined();
  });
});
describe('the loop throttle (§4.12)', () => {
  /** A receiving session whose model always answers, and can be made slow. */
  function receiver(replyDelayMs = 0) {
    const turns: string[] = [];
    return {
      turns,
      conversation: {
        ingress: {
          submit: async (req: { sessionId: string; message: { content: string } }) => {
            if (replyDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, replyDelayMs));
            turns.push(req.message.content);
            return {
              turnId: 'turn-1',
              completion: Promise.resolve({
                status: 'completed' as const,
                messages: [{ role: 'assistant', text: 'ack' }],
              }),
            };
          },
          abort: async () => undefined,
        },
      },
    };
  }

  const post = (dataDir: string, sessionId: string, from: string, content: string) =>
    sendToPeerInbox({
      dataDir,
      sessionId,
      message: { type: 'message', fromSessionId: from, content },
    });

  it('drops an identical message arriving moments later', async () => {
    const dataDir = await tempDataDir();
    const { conversation, turns } = receiver();
    const handle = await startSessionPeerInbox({ dataDir, sessionId: 'loop-a', conversation });

    expect((await post(dataDir, 'loop-a', 'peer-1', 'are you there?')).ok).toBe(true);
    const second = await post(dataDir, 'loop-a', 'peer-1', 'are you there?');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toContain('identical');
    expect(turns).toHaveLength(1);
  });

  it('stops a loop even when every message is different', async () => {
    const dataDir = await tempDataDir();
    const { conversation, turns } = receiver();
    const handle = await startSessionPeerInbox({ dataDir, sessionId: 'loop-b', conversation });

    const results = [];
    for (let index = 0; index < 12; index += 1) {
      results.push(await post(dataDir, 'loop-b', 'peer-1', `message number ${index}`));
    }
    const refused = results.filter((result) => !result.ok);
    expect(refused.length).toBeGreaterThan(0);
    expect(turns.length).toBeLessThan(12);
  });

  it('tells the sender a throttle fired, not that the session refused on policy', async () => {
    const dataDir = await tempDataDir();
    const { conversation, turns } = receiver();
    const handle = await startSessionPeerInbox({ dataDir, sessionId: 'throttle-say', conversation });
    MANAGED.push(handle);

    const first = await sendToPeerInbox({
      dataDir,
      sessionId: 'throttle-say',
      message: { type: 'message', fromSessionId: 'peer-1', content: 'only reply: ok' },
    });
    const repeat = await sendToPeerInbox({
      dataDir,
      sessionId: 'throttle-say',
      message: { type: 'message', fromSessionId: 'peer-1', content: 'only reply: ok' },
    });

    expect(first.ok).toBe(true);
    expect(repeat.ok).toBe(false);
    if (!repeat.ok) {
      expect(repeat.detail).toBe('throttled');
      expect(repeat.reason).toContain('loop throttle');
    }
    expect(turns).toHaveLength(1);
  });

  it('says plainly that a held message was not kept, rather than implying it waits', async () => {
    const dataDir = await tempDataDir();
    const { conversation, turns } = receiver();
    const handle = await startSessionPeerInbox({
      dataDir,
      sessionId: 'hold-a',
      conversation,
      inbound: 'hold',
    });

    const result = await post(dataDir, 'hold-a', 'peer-1', 'anything');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('not kept');
      expect(result.detail).toBe('refused');
      // §4.6's hold no longer reports a message as waiting when nothing keeps it.
    }
    expect(turns).toHaveLength(0);
  });

  it('refuses a session that refuses, and runs no Turn', async () => {
    const dataDir = await tempDataDir();
    const { conversation, turns } = receiver();
    const handle = await startSessionPeerInbox({
      dataDir,
      sessionId: 'refuse-a',
      conversation,
      inbound: 'refuse',
    });

    const result = await post(dataDir, 'refuse-a', 'peer-1', 'anything');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('refuses');
    expect(turns).toHaveLength(0);
  });

  it('waits for a peer that takes its time instead of failing on the line deadline', async () => {
    const dataDir = await tempDataDir();
    // The reply deadline is separate from the 30s protocol window, so a peer that
    // needs a moment is answered rather than cut off.
    const { conversation } = receiver(120);
    const handle = await startSessionPeerInbox({ dataDir, sessionId: 'slow-a', conversation });

    const result = await post(dataDir, 'slow-a', 'peer-1', 'take your time');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply.content).toBe('ack');
  });
});

describe('admitting a message to a busy session (§4.4)', () => {
  /** A session whose Turn is busy for the first `busyFor` admissions. */
  function busyThenFree(busyFor: number, admission: { count: number; content: string[] }) {
    return {
      ingress: {
        submit: async (req: { message: { content: string } }) => {
          admission.count += 1;
          if (admission.count <= busyFor) {
            throw new Error('Internal error: Session already has an active Turn.');
          }
          admission.content.push(req.message.content);
          return {
            turnId: 'turn-1',
            completion: Promise.resolve({
              status: 'completed' as const,
              messages: [{ role: 'assistant', text: 'stopped and reported' }],
            }),
          };
        },
        abort: async () => undefined,
      },
    };
  }

  const fastRetry = { intervalMs: 5, deadlineMs: 400 };

  it('waits for the running Turn instead of refusing or interrupting it', async () => {
    const dataDir = await tempDataDir();
    const admission = { count: 0, content: [] as string[] };
    const handle = await startSessionPeerInbox({
      dataDir,
      sessionId: 'busy-1',
      conversation: busyThenFree(3, admission),
      admitRetry: fastRetry,
    });

    const result = await sendToPeerInbox({
      dataDir,
      sessionId: 'busy-1',
      message: { type: 'message', fromSessionId: 'peer', content: 'stop what you are doing' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reply.content).toBe('stopped and reported');
    // The message ran exactly once, on the Turn that started after the busy one
    // finished — not merged into the busy Turn and not attempted five times.
    expect(admission.content).toHaveLength(1);
  });

  it('gives up on a session that never frees up, and says so', async () => {
    const dataDir = await tempDataDir();
    const admission = { count: 0, content: [] as string[] };
    const handle = await startSessionPeerInbox({
      dataDir,
      sessionId: 'busy-2',
      conversation: busyThenFree(Number.MAX_SAFE_INTEGER, admission),
      admitRetry: fastRetry,
    });

    const result = await sendToPeerInbox({
      dataDir,
      sessionId: 'busy-2',
      message: { type: 'message', fromSessionId: 'peer', content: 'are you there' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('stayed busy');
    expect(admission.content).toHaveLength(0);
  });
});

describe('a session that died without closing its socket', () => {
  it('is dropped from the roster instead of answering with ECONNREFUSED', async () => {
    const dataDir = await tempDataDir();
    const inbox = await openInbox(dataDir, 'alive', () => 'ok');
    await inbox.handle.close();

    // The close removed the file. Put it back to model a process that died:
    // the listener is gone but the path a peer would dial is still there.
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(dataDir, 'run', 'inbox'), { recursive: true });
    await writeFile(join(dataDir, 'run', 'inbox', 'alive.sock'), 'not a live socket');

    // Never reported as reachable, and cleaned up on the same pass.
    expect(await listLiveInboxes(dataDir)).not.toContain('alive');
    expect(await listLiveInboxes(dataDir)).not.toContain('alive');
  });

  it('leaves a session that is still listening alone', async () => {
    const dataDir = await tempDataDir();
    await openInbox(dataDir, 'live-one', () => 'ok');
    expect(await listLiveInboxes(dataDir)).toContain('live-one');
    expect(await listLiveInboxes(dataDir)).toContain('live-one');
  });
});

describe('delivery is not the same as a reply (§4.4)', () => {
  it('reports a peer that took too long as delivered, so the model does not re-send', async () => {
    const dataDir = await tempDataDir();
    const deps = { ...runtimeHarness(dataDir, {
      'sess-a': { title: 'mmx-a' },
      'sess-b': { title: 'mmx-b' },
    }).deps, replyTimeoutMs: 150 };
    // A peer that never answers: the message still reached it.
    const inbox = await openInbox(dataDir, 'sess-b', () => new Promise<string>(() => {}));
    const tool = new SendMessageTool(buildPeerMessagingAdapter(deps));

    const result = await tool.execute(
      { sessionId: 'sess-a' } as LocalRuntimeToolContext,
      { to: 'mmx-b', message: 'ping' },
    );
    expect(inbox.received).toHaveLength(1);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('has not replied');
  });

  it('tells the model not to re-send when delivery happened without an answer', async () => {
    const tool = new SendMessageTool(
      stubAdapterForNoReply(),
    );
    const result = await tool.execute(
      { sessionId: 'sess-a' } as LocalRuntimeToolContext,
      { to: 'mmx-b', message: 'ping' },
    );
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('has not replied');
    expect(result.text).toContain('Do not send this message again');
    expect(result.details?.replied).toBe(false);
  });

  function stubAdapterForNoReply() {
    return {
      listPeers: async () => [],
      sendMessage: async () => ({
        delivered: true as const,
        reply: '',
        targetSessionId: 'sess-b',
        targetName: 'mmx-b',
      }),
    };
  }
});
