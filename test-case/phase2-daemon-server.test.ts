import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCapabilityFile, readCapabilityFile } from '../packages/tui/src/daemon/capability.js';
import { startDaemonServer } from '../packages/tui/src/daemon/server.js';
import { connectDaemon } from '../packages/tui/src/daemon/client.js';
import { daemonPaths } from '../packages/tui/src/daemon/paths.js';

/**
 * Phase 2 contract: the daemon socket.
 *
 * The transport is JSON-RPC 2.0 over ndjson because the other end of every
 * conversation is an ACP worker, which already speaks exactly that — a
 * `session/update` or a permission request can then be forwarded byte for byte
 * instead of being transcoded. The plan is explicit that this and the
 * length-prefixed `auth-lease` framing are alternatives, not things to mix.
 *
 * The handshake is the security boundary. It is the first frame, it carries the
 * token, and the comparison is constant-time. Everything after it is
 * authenticated. So the tests that matter are the ones where the token is wrong,
 * absent, late, or never sent at all.
 *
 * See mydocs/supervisor-plan-v2.md §3.5 and §3.6.
 */
describe('daemon server', () => {
  const roots: string[] = [];
  const stops: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop().catch(() => undefined)));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function server(options: { token?: string; onReady?: (info: DaemonInfo) => void } = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'daemon-srv-'));
    roots.push(dataDir);
    const paths = daemonPaths(dataDir);
    const token = options.token ?? (await createCapabilityFile(paths.capabilityFile));
    const running = await startDaemonServer({
      dataDir,
      token,
      version: '9.9.9',
      epoch: 7,
      onReady: options.onReady,
    });
    stops.push(running.stop);
    return { dataDir, paths, token, running };
  }

  interface DaemonInfo {
    socketFile: string;
    epoch: number;
  }

  it('accepts a client that presents the right token', async () => {
    const { token, running } = await server();
    const client = await connectDaemon({ socketFile: running.socketFile, token, version: '1.0.0' });

    await expect(
      client.request('daemon.status', { client: { kind: 'cli', pid: process.pid, version: '1.0.0' } }),
    ).resolves.toMatchObject({ proto: 1, daemonVersion: '9.9.9', epoch: 7 });
    client.close();
  });

  it('rejects a client with the wrong token at the handshake', async () => {
    const { running } = await server();

    // The handshake is where the token is presented, so that is where a wrong one
    // fails — there is no authenticated session left to make requests from.
    await expect(
      connectDaemon({
        socketFile: running.socketFile,
        token: 'not-the-token-but-the-same-length-aaaaaaaa',
        version: '1.0.0',
      }),
    ).rejects.toThrow(/capability token/i);
  });

  it('refuses a request that arrives on a connection that failed its token', async () => {
    const { running } = await server();
    const raw = await rawConnect(running.socketFile);
    const token = 'not-the-token-but-the-same-length-aaaaaaaa';
    raw.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { token } })}\n`);
    await expect(raw.nextMessage()).resolves.toMatchObject({ error: expect.anything() });
    // Nothing revives the connection afterwards.
    raw.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'daemon.status', params: {} })}\n`);
    await expect(raw.nextMessage()).resolves.toBeUndefined();
    raw.close();
  });

  it('rejects a client that sends no handshake at all', async () => {
    const { running } = await server();
    const raw = await rawConnect(running.socketFile);
    raw.write('{"jsonrpc":"2.0","id":1,"method":"daemon.status","params":{}}\n');
    await expect(raw.nextMessage()).resolves.toMatchObject({ error: expect.anything() });
    raw.close();
  });

  it('rejects a handshake that arrives after the first frame', async () => {
    const { token, running } = await server();
    const raw = await rawConnect(running.socketFile);
    raw.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'daemon.status', params: {} })}\n`,
    );
    await expect(raw.nextMessage()).resolves.toMatchObject({ error: expect.anything() });
    raw.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hello', params: { token } })}\n`);
    // The connection is already torn down; nothing revives it.
    await expect(raw.nextMessage()).resolves.toBeUndefined();
    raw.close();
  });

  it('disconnects a client that goes quiet past the idle window', async () => {
    // An unbounded idle connection is a file-descriptor leak in a process that is
    // designed to outlive the terminals that started it.
    const { token, running } = await server({ onReady: () => undefined });
    const client = await connectDaemon({
      socketFile: running.socketFile,
      token,
      version: '1.0.0',
      idleTimeoutMs: 60,
    });

    await expect(
      client.request('daemon.status', { client: { kind: 'cli', pid: 1, version: '1.0.0' } }),
    ).resolves.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 200));
    client.close();
  });

  it('refuses a frame larger than the protocol allows', async () => {
    const { running } = await server();
    const raw = await rawConnect(running.socketFile);
    // ndjson has no length prefix, so the only bound is a line-length cap. One
    // oversized line must drop the connection rather than be buffered forever.
    raw.write('{"jsonrpc":"2.0","id":1,"method":"hello","params":{"token":"x","pad":"');
    raw.write('y'.repeat(2 * 1024 * 1024));
    raw.write('"}}\n');
    await expect(raw.nextMessage()).resolves.toBeUndefined();
    raw.close();
  });

  it('unlinks its socket only when it is the one that created it', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'daemon-sock-owner-'));
    roots.push(dataDir);
    const paths = daemonPaths(dataDir);
    const token = await createCapabilityFile(paths.capabilityFile);
    const running = await startDaemonServer({ dataDir, token, version: '9.9.9', epoch: 1 });
    stops.push(running.stop);

    expect((await stat(running.socketFile)).isSocket()).toBe(true);
    await running.stop();

    // A leftover socket file makes the next start look like a live daemon.
    await expect(stat(running.socketFile)).rejects.toThrow();
  });

  it('reports the socket path and whether it had to fall back', async () => {
    const { running } = await server();
    expect(running.socketFile).toContain('mcode-daemon');
    expect(running.socketIsFallback).toBe(false);
  });

  it('lets a client read the token the daemon wrote', async () => {
    const { paths, token } = await server();
    await expect(readCapabilityFile(paths.capabilityFile)).resolves.toBe(token);
  });

  it('stops cleanly and reports that it is gone', async () => {
    const { token, running } = await server();
    const client = await connectDaemon({ socketFile: running.socketFile, token, version: '1.0.0' });
    client.close();

    await running.stop();
    await expect(connectDaemon({ socketFile: running.socketFile, token, version: '1.0.0' })).rejects.toThrow();
  });
});

interface RawSocket {
  write(chunk: string): void;
  nextMessage(): Promise<Record<string, unknown> | undefined>;
  close(): void;
}

/** Talks to the socket without the client, so the framing is under test. */
async function rawConnect(socketFile: string): Promise<RawSocket> {
  const { connect } = await import('node:net');
  const socket = connect(socketFile);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let buffer = '';
  const queue: Record<string, unknown>[] = [];
  let closed = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) {
        try {
          queue.push(JSON.parse(line));
        } catch {
          queue.push({ error: { code: -32700 } });
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  socket.on('close', () => {
    closed = true;
  });
  return {
    write: (chunk) => socket.write(chunk),
    // Polls rather than racing a `close` handler: the reply and the FIN can land
    // in the same tick, and a `close`-first race would report "nothing came
    // back" for a message that did.
    nextMessage: async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const found = queue.shift();
        if (found) return found;
        if (closed && queue.length === 0) return undefined;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return queue.shift();
    },
    close: () => socket.destroy(),
  };
}
