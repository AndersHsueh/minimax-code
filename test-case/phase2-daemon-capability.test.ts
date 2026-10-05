import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  constantTimeTokenEquals,
  createCapabilityFile,
  readCapabilityFile,
} from '../packages/tui/src/daemon/capability.js';

/**
 * Phase 2 contract: the daemon's capability token.
 *
 * The token is the only thing standing between "any process that can reach the
 * socket" and "a process that can drive every background job the user owns". The
 * socket is mode 0600, but that is a weaker guarantee than it looks: a wrong
 * 0600 on the parent directory, a different uid, or a bind in a shared /tmp all
 * break it. So the token has to be right on its own.
 *
 * Three properties matter, and each has a failure that is silent:
 *
 *  - **It never goes in the environment.** `daemon run` is spawned detached with a
 *    sanitized env; a token in `env` is readable from `/proc/<pid>/environ` by
 *    the same user and inherited by every child.
 *  - **It is compared in constant time.** A byte-by-byte compare leaks the prefix
 *    through timing, and a base64url token is compared byte-by-byte by naive code.
 *  - **It is written atomically at 0600.** A partial read must be a rejected
 *    connection, never a truncated token that happens to match.
 *
 * See mydocs/supervisor-plan-v2.md §3.5 and §3.6.
 */
describe('daemon capability token', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function tempFile(name = 'daemon.cap'): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-cap-'));
    roots.push(dir);
    return join(dir, name);
  }

  it('writes a fresh high-entropy token that is not readable by anyone else', async () => {
    const file = await tempFile();
    const token = await createCapabilityFile(file);

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 random bytes, base64url — no padding, no `+`/`/`.
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(await readCapabilityFile(file)).toBe(token);
  });

  it('creates the directory private and the file owner-only', async () => {
    const file = await tempFile('nested/deep/daemon.cap');
    await createCapabilityFile(file);

    if (process.platform !== 'win32') {
      expect((await stat(join(file, '..'))).mode & 0o777).toBe(0o700);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it('leaves no temporary file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-cap-'));
    roots.push(dir);
    const file = join(dir, 'daemon.cap');

    await createCapabilityFile(file);
    await createCapabilityFile(file);

    // The atomic write is a temp file plus a rename; a leaked temp would be a
    // second copy of the secret sitting in the same directory.
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(dir)).sort()).toEqual(['daemon.cap']);
  });

  it('replaces an existing token rather than appending to it', async () => {
    const file = await tempFile();
    await writeFile(file, 'stale-token-that-should-not-survive\n');

    const token = await createCapabilityFile(file);

    expect(token).not.toContain('stale-token');
    expect(await readCapabilityFile(file)).toBe(token);
  });

  it('compares equal tokens as equal and different ones as different', async () => {
    const a = 'aGVsbG8td29ybGQtdG9rZW4';
    expect(constantTimeTokenEquals(a, a)).toBe(true);
    expect(constantTimeTokenEquals(a, `${a}X`)).toBe(false);
    expect(constantTimeTokenEquals(a, `${a.slice(0, -1)}Y`)).toBe(false);
    expect(constantTimeTokenEquals(a, 'Z'.repeat(a.length))).toBe(false);
  });

  it('refuses a length mismatch without throwing', () => {
    // `timingSafeEqual` throws on unequal buffer lengths. A client that guessed a
    // short token would otherwise get a stack trace instead of a rejected
    // connection, which leaks that the guess reached the comparison at all.
    expect(constantTimeTokenEquals('short', 'much-longer-token')).toBe(false);
    expect(constantTimeTokenEquals('much-longer-token', 'short')).toBe(false);
  });

  it('refuses an empty or missing presented token', async () => {
    const file = await tempFile();
    const token = await createCapabilityFile(file);

    expect(constantTimeTokenEquals('', token)).toBe(false);
    expect(constantTimeTokenEquals(undefined, token)).toBe(false);
    expect(constantTimeTokenEquals(token, undefined)).toBe(false);
  });

  it('reports a missing token file as a refusal, not as an empty token', async () => {
    const file = await tempFile('absent/daemon.cap');
    await expect(readCapabilityFile(file)).rejects.toThrow();
  });

  it('rejects a token file that is not owner-only', async () => {
    if (process.platform === 'win32') return;
    const file = await tempFile();
    await writeFile(file, `${'a'.repeat(43)}\n`, { mode: 0o644 });
    await (await import('node:fs/promises')).chmod(file, 0o644);

    // A world-readable token is a leaked token. Better to refuse the connection
    // than to accept one.
    await expect(readCapabilityFile(file)).rejects.toThrow(/permission/i);
  });

  it('round-trips through the file with no whitespace surprises', async () => {
    const file = await tempFile();
    const token = await createCapabilityFile(file);
    const raw = await readFile(file, 'utf8');

    expect(raw).toBe(`${token}\n`);
    expect((await readCapabilityFile(file))?.length).toBe(token.length);
  });
});
