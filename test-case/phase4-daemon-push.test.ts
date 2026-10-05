import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCapabilityFile } from '../packages/tui/src/daemon/capability.js';
import { connectDaemon } from '../packages/tui/src/daemon/client.js';
import { daemonPaths } from '../packages/tui/src/daemon/paths.js';
import { startDaemonServer } from '../packages/tui/src/daemon/server.js';
import { isNotificationFrame, serializeFrame } from '../packages/tui/src/daemon/ndjson.js';

/**
 * Phase 4 contract: the footer's `← N awaiting` is fed by push, not polling.
 *
 * The spec is explicit — "订阅 daemon 推送,**不需要轮询**" — and the reason is
 * behavioural, not performance. A badge is a claim that a human is needed. A
 * poll interval means the badge is wrong by up to one interval, and the one
 * moment a job parks on a permission question is exactly the moment the user is
 * not looking at the TUI. Worse, a client that polls cannot distinguish "nothing
 * is waiting" from "the daemon is gone", and the plan requires those to render
 * differently: no badge when the supervisor is unreachable.
 *
 * So the transport has to carry server-initiated frames. That is a real change
 * to the ndjson layer — a response is keyed by `id`, and a notification has
 * none, so a client that only resolves pending requests would drop every push on
 * the floor.
 *
 * See mydocs/supervisor-plan-v2.md Phase 4, §3.5.
 */
describe('daemon push notifications', () => {
  const roots: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop().catch(() => undefined)));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function server() {
    const dataDir = await mkdtemp(join(tmpdir(), 'daemon-push-'));
    roots.push(dataDir);
    const paths = daemonPaths(dataDir);
    const token = await createCapabilityFile(paths.capabilityFile);
    const running = await startDaemonServer({ dataDir, token, version: '9.9.9', epoch: 3 });
    stops.push(running.stop);
    return { dataDir, paths, token, running };
  }

  describe('frame classification', () => {
    it('recognises a notification as neither a request nor a response', () => {
      // A push has a `method` and no `id`. The two existing predicates both
      // reject it, which is exactly why it needs a third: without one, every
      // server-initiated frame is either answered with an error or ignored.
      const notification = { jsonrpc: '2.0', method: 'job.state', params: { sessionId: 's' } };

      expect(isNotificationFrame(notification)).toBe(true);
    });

    it('does not mistake a response for a notification', () => {
      expect(isNotificationFrame({ jsonrpc: '2.0', id: 1, result: {} })).toBe(false);
    });

    it('does not mistake a request for a notification', () => {
      // The handshake is a request, and reclassifying it would let a
      // notification handler run on a frame that is awaiting a reply.
      expect(isNotificationFrame({ jsonrpc: '2.0', id: 1, method: 'hello' })).toBe(false);
    });

    it('round-trips a notification through the wire format', () => {
      const line = serializeFrame({
        jsonrpc: '2.0',
        method: 'job.awaiting',
        params: { count: 2 },
      } as never);

      expect(JSON.parse(line.trim())).toEqual({
        jsonrpc: '2.0',
        method: 'job.awaiting',
        params: { count: 2 },
      });
    });
  });

  describe('server push', () => {
    it('delivers a notification to a connected client', async () => {
      const { token, running } = await server();
      const client = await connectDaemon({
        socketFile: running.socketFile,
        token,
        version: '1.0.0',
        kind: 'tui',
      });
      const received: unknown[] = [];
      client.onNotification?.((method, params) => received.push({ method, params }));

      running.broadcast('job.awaiting', { count: 1 });
      await waitFor(() => received.length > 0);

      expect(received).toEqual([{ method: 'job.awaiting', params: { count: 1 } }]);
      client.close();
    });

    it('serves a client that only subscribes and never requests again', async () => {
      const { token, running } = await server();
      const client = await connectDaemon({
        socketFile: running.socketFile,
        token,
        version: '1.0.0',
        kind: 'tui',
      });
      const received: { method: string }[] = [];
      client.onNotification?.((method) => received.push({ method }));

      // The whole point: after the handshake the client is idle. If pushes
      // needed a request to be in flight, the badge would never move.
      client.request('daemon.status');
      running.broadcast('job.awaiting', { count: 1 });
      running.broadcast('job.awaiting', { count: 0 });
      await waitFor(() => received.length >= 2);

      expect(received.map((entry) => entry.method)).toEqual([
        'job.awaiting',
        'job.awaiting',
      ]);
      client.close();
    });

    it('does not deliver to a client that has closed', async () => {
      const { token, running } = await server();
      const client = await connectDaemon({
        socketFile: running.socketFile,
        token,
        version: '1.0.0',
      });
      const received: unknown[] = [];
      client.onNotification?.(() => received.push(1));
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(() => running.broadcast('job.awaiting', { count: 1 })).not.toThrow();
      expect(received).toEqual([]);
    });

    it('keeps serving requests after a push has been delivered', async () => {
      const { token, running } = await server();
      const client = await connectDaemon({
        socketFile: running.socketFile,
        token,
        version: '1.0.0',
      });
      const received: unknown[] = [];
      client.onNotification?.(() => received.push(1));

      running.broadcast('job.awaiting', { count: 3 });
      await waitFor(() => received.length > 0);
      const status = await client.request('daemon.status');

      expect(status).toMatchObject({ epoch: 3 });
      client.close();
    });
  });

  describe('connection bookkeeping', () => {
    it('reports how many peers are connected', async () => {
      const { token, running } = await server();
      expect(running.subscriberCount()).toBe(0);

      // Every authenticated connection is a push target. A `mcode agents`
      // one-liner simply never registers a handler, which is cheaper than
      // making clients opt in and then forget to.
      const client = await connectDaemon({
        socketFile: running.socketFile,
        token,
        version: '1.0.0',
      });
      await waitFor(() => running.subscriberCount() === 1);
      expect(running.subscriberCount()).toBe(1);

      client.close();
      await waitFor(() => running.subscriberCount() === 0);
    });

    it('forgets a peer that vanished without closing cleanly', async () => {
      const { token, running } = await server();
      const client = await connectDaemon({
        socketFile: running.socketFile,
        token,
        version: '1.0.0',
      });
      await waitFor(() => running.subscriberCount() === 1);

      // A TUI that is `kill -9`ed never sends a goodbye. A daemon that keeps
      // writing to that socket forever is a slow leak of one buffer per push.
      client.close();
      await waitFor(() => running.subscriberCount() === 0);
    });
  });

  describe('liveness', () => {
    it('does not push a count while nothing is connected', async () => {
      const { running } = await server();
      const send = vi.fn();

      expect(() => running.broadcast('job.awaiting', { count: 0 })).not.toThrow();
      expect(send).not.toHaveBeenCalled();
    });
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
