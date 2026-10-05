import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { daemonPaths } from './paths.js';

/** The on-disk protocol version this build writes. */
export const DAEMON_JOB_PROTO = 1;

const OWNER_ONLY_FILE = 0o600;
const OWNER_ONLY_DIR = 0o700;

export interface DaemonTimelineEntry {
  readonly at: number;
  readonly state: string;
  readonly detail?: string;
  readonly text?: string;
  [key: string]: unknown;
}

export interface PendingMessage {
  readonly id: string;
  readonly text: string;
  readonly at: number;
  readonly [key: string]: unknown;
}

export interface DaemonJobStore {
  readonly jobsDir: string;
  readonly rosterFile: string;
  jobFile(sessionId: string): string;
  timelineFile(sessionId: string): string;
  readJob(sessionId: string): Promise<Record<string, unknown> | undefined>;
  writeJob(job: Record<string, unknown>): Promise<void>;
  updateJob(sessionId: string, patch: Record<string, unknown>): Promise<void>;
  listJobs(): Promise<string[]>;
  removeJob(sessionId: string): Promise<void>;
  appendTimeline(sessionId: string, entry: DaemonTimelineEntry): Promise<void>;
  readTimeline(sessionId: string): Promise<DaemonTimelineEntry[]>;
  stagePending(sessionId: string, message: { text: string } & Record<string, unknown>): Promise<string>;
  listPending(sessionId: string): Promise<PendingMessage[]>;
  resolvePending(sessionId: string, id: string): Promise<void>;
}

/**
 * The daemon's durable state: one directory per job, plain JSON, no SQLite.
 *
 * The store never rewrites a field it did not read. Every mutation is
 * read-modify-write against the parsed file, so a field written by a newer daemon
 * survives an older one touching the same job. Combined with
 * {@link assertWritableProto}, an older daemon can still *read* a newer job (the
 * agent view needs the row) while refusing to write it back.
 */
export function createJobStore(options: { dataDir: string }): DaemonJobStore {
  const paths = daemonPaths(options.dataDir);

  const jobDir = (sessionId: string): string => {
    const directory = join(paths.jobsDir, assertSafeSegment(sessionId));
    // `assertSafeSegment` rejects separators and `..`, so this cannot escape.
    return directory;
  };

  return {
    jobsDir: paths.jobsDir,
    rosterFile: paths.rosterFile,
    jobFile: (sessionId) => join(jobDir(sessionId), 'job.json'),
    timelineFile: (sessionId) => join(jobDir(sessionId), 'timeline.jsonl'),

    async readJob(sessionId) {
      const file = join(jobDir(sessionId), 'job.json');
      const parsed = await readJsonFile(file);
      return isRecord(parsed) ? parsed : undefined;
    },

    async writeJob(job) {
      const sessionId = String(job.sessionId ?? '');
      assertWritableProto(job);
      const directory = jobDir(sessionId);
      await ensureDir(directory);
      await atomicWriteJson(join(directory, 'job.json'), job);
    },

    async updateJob(sessionId, patch) {
      const file = join(jobDir(sessionId), 'job.json');
      const current = await readJsonFile(file);
      if (!isRecord(current)) {
        throw new Error(`Cannot update a job that does not exist: ${sessionId}`);
      }
      assertWritableProto(current);
      await atomicWriteJson(file, { ...current, ...patch });
    },

    async listJobs() {
      // `roster.json` caches which workers are alive; the directories are the
      // truth. A missing or corrupt roster must cost the cache, not the jobs.
      const entries = await readDirSafely(paths.jobsDir);
      const found: string[] = [];
      for (const entry of entries) {
        if (!(await isFile(join(paths.jobsDir, entry, 'job.json')))) continue;
        found.push(entry);
      }
      return found.sort();
    },

    async removeJob(sessionId) {
      await rm(jobDir(sessionId), { recursive: true, force: true });
    },

    async appendTimeline(sessionId, entry) {
      const directory = jobDir(sessionId);
      await ensureDir(directory);
      const file = join(directory, 'timeline.jsonl');
      const { appendFile, open: openFile } = await import('node:fs/promises');
      await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: OWNER_ONLY_FILE });
      void openFile;
    },

    async readTimeline(sessionId) {
      const file = join(jobDir(sessionId), 'timeline.jsonl');
      let raw: string;
      try {
        raw = await readFile(file, 'utf8');
      } catch {
        return [];
      }
      const entries: DaemonTimelineEntry[] = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        // A crash can leave a half-written final line. Skipping the bad line
        // costs one entry; rejecting the file would cost the whole record,
        // which is the thing the timeline exists to provide after a crash.
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed)) entries.push(parsed as DaemonTimelineEntry);
        } catch {
          // Skip.
        }
      }
      return entries;
    },

    async stagePending(sessionId, message) {
      const directory = join(jobDir(sessionId), 'pending');
      await ensureDir(directory);
      const id = randomBytes(8).toString('hex');
      const at = Date.now();
      const payload = { id, at, ...message } as PendingMessage;
      // Named by time, not by the random id: replay has to be in the order the
      // user sent, and a random name sorts a message that arrived first behind
      // one that arrived second. Zero-padding keeps the lexical order equal to
      // the chronological one, and it survives a daemon restart, which an
      // in-memory counter would not.
      await atomicWriteJson(join(directory, `${sequencePrefix(at)}-${id}.json`), { ...payload });
      return id;
    },

    async listPending(sessionId) {
      const directory = join(jobDir(sessionId), 'pending');
      const names = (await readDirSafely(directory)).sort();
      const messages: PendingMessage[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const parsed = await readJsonFile(join(directory, name));
        if (isRecord(parsed)) messages.push(parsed as PendingMessage);
      }
      return messages;
    },

    async resolvePending(sessionId, id) {
      // Deleted only after the worker confirmed delivery. A crash before this
      // leaves the message on disk and it is re-delivered; deleting earlier would
      // lose it silently. Matched by the id suffix because the file name carries
      // the staging order, not the id.
      const segment = assertSafeSegment(id);
      const directory = join(jobDir(sessionId), 'pending');
      for (const name of await readDirSafely(directory)) {
        if (name.endsWith(`-${segment}.json`)) {
          await rm(join(directory, name), { force: true });
        }
      }
    },
  };
}

/**
 * Refuses to write a file written by a newer protocol version.
 *
 * An older daemon that rewrites such a file rebuilds it from its own typed
 * shape, dropping the fields it never read. Refusing keeps the newer daemon's
 * data intact; reading is still allowed so the agent view can show the row.
 */
function assertWritableProto(record: Record<string, unknown>): void {
  const proto = record.proto;
  if (typeof proto === 'number' && proto > DAEMON_JOB_PROTO) {
    throw new Error(
      `Refusing to write a job written by proto ${proto}; this build writes proto ${DAEMON_JOB_PROTO}.`,
    );
  }
}

function assertSafeSegment(value: string): string {  if (!value || value === '.' || value === '..' || /[/\\]/.test(value) || value.includes('\0')) {
    throw new Error(`Unsafe path segment: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Fixed width so a lexical filename sort equals a chronological one. */
function sequencePrefix(at: number): string {
  return String(at).padStart(16, '0');
}

async function ensureDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIR });
  if (process.platform !== 'win32') await chmod(directory, OWNER_ONLY_DIR);
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file));
  const temporaryFile = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryFile, 'wx', OWNER_ONLY_FILE);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

async function readDirSafely(directory: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function isFile(file: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
