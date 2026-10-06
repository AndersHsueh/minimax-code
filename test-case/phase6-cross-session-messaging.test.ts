import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listBoundPeerSessions,
  sendToPeerInbox,
  startPeerInbox,
  type PeerInboxHandle,
  type PeerMessageEnvelope,
} from '../packages/local-runtime/src/communication/peer-inbox.js';
import { releaseAllSessionInboxes } from '../packages/local-runtime/src/communication/peer-inbox-manager.js';
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
const MANAGED: LocalInbox[] = [];

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
      throw Object.assign(new Error('this session refuses messages'), { peerInbound: 'refused' });
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

  it('distinguishes a held message from a refused one (§4.6)', async () => {
    const dataDir = await tempDataDir();
    await openInbox(dataDir, 'sess-b', () => {
      throw Object.assign(new Error('waiting for approval'), { peerInbound: 'held' });
    });

    const result = await sendToPeerInbox({
      dataDir,
      sessionId: 'sess-b',
      message: { type: 'message', fromSessionId: 'sess-a', content: 'hi' },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toBe('held');
  });

  it('lists only the sessions that actually bound a socket', async () => {
    const dataDir = await tempDataDir();
    expect(await listBoundPeerSessions(dataDir)).toEqual([]);
    await openInbox(dataDir, 'sess-a', () => 'ok');
    await openInbox(dataDir, 'sess-b', () => 'ok');
    expect((await listBoundPeerSessions(dataDir)).sort()).toEqual(['sess-a', 'sess-b']);
  });

  it('drops a session from the listing once its process closes the socket', async () => {
    const dataDir = await tempDataDir();
    const inbox = await openInbox(dataDir, 'sess-a', () => 'ok');
    expect(await listBoundPeerSessions(dataDir)).toEqual(['sess-a']);
    await inbox.handle.close();
    expect(await listBoundPeerSessions(dataDir)).toEqual([]);
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
    readSessionName: async (sessionId: string) => sessions[sessionId]?.title,
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