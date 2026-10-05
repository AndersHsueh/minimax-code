import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** 32 random bytes; the token is a bearer credential, so it is sized for guessing resistance. */
const TOKEN_BYTES = 32;
const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

/**
 * Writes a fresh capability token, replacing any previous one.
 *
 * The write is a temp file, an `fsync`, and a `rename` — the same shape as
 * `lease-broker.ts:246-261`. A reader that catches a partially written token would
 * otherwise compare a truncated value and could accept it.
 */
export async function createCapabilityFile(file: string): Promise<string> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIR });
  if (process.platform !== 'win32') await chmod(directory, OWNER_ONLY_DIR);
  const temporaryFile = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryFile, 'wx', OWNER_ONLY_FILE);
    await handle.writeFile(`${token}\n`, 'utf8');
    await handle.sync();
    if (process.platform !== 'win32') await handle.chmod(OWNER_ONLY_FILE);
    await handle.close();
    handle = undefined;
    await rename(temporaryFile, file);
    if (process.platform !== 'win32') await chmod(file, OWNER_ONLY_FILE);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true });
    throw error;
  }
  return token;
}

/**
 * Reads the daemon's own token. Rejects a file that is readable by anyone else:
 * at that point the token is a leaked token, and serving it is worse than
 * refusing the connection.
 */
export async function readCapabilityFile(file: string): Promise<string> {
  if (process.platform !== 'win32') {
    const mode = (await stat(file)).mode & 0o777;
    if (mode & 0o077) {
      throw new Error(
        `Capability file permission denied: ${file} is mode ${mode.toString(8)}, expected 600.`,
      );
    }
  }
  const token = (await readFile(file, 'utf8')).trim();
  if (!token) throw new Error(`Capability file is empty: ${file}`);
  return token;
}

/**
 * Constant-time comparison that treats a length mismatch as a plain `false`.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so calling it
 * directly turns a wrong-length guess into an exception — which both tells the
 * caller the guess reached the comparison and skips the comparison entirely.
 * The length is compared first, in the open, because the length of a
 * fixed-size token is not a secret.
 */
export function constantTimeTokenEquals(
  presented: string | undefined,
  expected: string | undefined,
): boolean {
  if (!presented || !expected) return false;
  const presentedBytes = Buffer.from(presented, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}
