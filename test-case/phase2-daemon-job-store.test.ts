import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createJobStore } from '../packages/tui/src/daemon/job-store.js';

/**
 * Phase 2 contract: the on-disk job roster.
 *
 * Two rules carry all the weight, and both exist because a daemon can be
 * upgraded, downgraded, or `kill -9`ed while writing.
 *
 * **Unknown fields survive a read-modify-write.** A newer daemon writes a field
 * an older one has never heard of; if the older one rewrites the file from its
 * own typed shape, that field is destroyed. Two daemons in sequence is not a
 * corner case here — it is what an interrupted upgrade looks like.
 *
 * **`proto` only ever moves forward.** An older daemon must be able to read a
 * newer file (by ignoring what it does not understand) without writing to it.
 * Writing back at the same time would rewrite the fields it just ignored.
 *
 * Everything lives as JSON outside SQLite on purpose: upstream owns the
 * migrations, migration numbering is what collides at source sync, and a daemon
 * has no business opening the runtime database at all.
 *
 * See mydocs/supervisor-plan-v2.md §3.4.
 */
describe('daemon job store', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function store(): Promise<ReturnType<typeof createJobStore>> {
    const dataDir = await mkdtemp(join(tmpdir(), 'daemon-jobs-'));
    roots.push(dataDir);
    return createJobStore({ dataDir });
  }

  const job = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    proto: 1,
    sessionId,
    state: 'idle' as const,
    ...extra,
  });

  it('round-trips a job through disk', async () => {
    const jobs = await store();
    await jobs.writeJob(
      job('session-1', { name: 'refactor', lane: 'default', launch: { permissionMode: 'default' } }),
    );

    await expect(jobs.readJob('session-1')).resolves.toMatchObject({
      proto: 1,
      sessionId: 'session-1',
      name: 'refactor',
    });
  });

  it('lists jobs in a stable order', async () => {
    const jobs = await store();
    await jobs.writeJob(job('session-c'));
    await jobs.writeJob(job('session-a'));
    await jobs.writeJob(job('session-b'));

    // The agent view renders this list; an unstable order makes rows jump.
    await expect(jobs.listJobs()).resolves.toEqual(['session-a', 'session-b', 'session-c']);
  });

  it('treats a missing job as absent rather than throwing', async () => {
    const jobs = await store();
    await expect(jobs.readJob('nope')).resolves.toBeUndefined();
    await expect(jobs.listJobs()).resolves.toEqual([]);
  });

  it('keeps fields it does not understand when updating a known one', async () => {
    // The failure this prevents: an older daemon rewrites the file from its own
    // typed shape and silently drops a newer daemon's field.
    const jobs = await store();
    await jobs.writeJob({
      ...job('session-1'),
      somethingFromTheFuture: { nested: true },
      anotherNewField: 42,
    });

    await jobs.updateJob('session-1', { state: 'running' });

    const written = JSON.parse(await readFile(jobs.jobFile('session-1'), 'utf8'));
    expect(written.state).toBe('running');
    expect(written.somethingFromTheFuture).toEqual({ nested: true });
    expect(written.anotherNewField).toBe(42);
  });

  it('refuses to write a file written by a newer protocol version', async () => {
    const jobs = await store();
    // Written straight to disk: `writeJob` is itself the guard under test, and a
    // newer daemon is exactly the case that cannot go through it.
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(jobs.jobsDir, 'session-1'), { recursive: true });
    await writeFile(
      jobs.jobFile('session-1'),
      JSON.stringify({ proto: 2, sessionId: 'session-1', state: 'queued', futureField: true }),
    );

    // Reading is fine — an older daemon may still need to show the row.
    await expect(jobs.readJob('session-1')).resolves.toMatchObject({ proto: 2 });
    // Writing is not: it would drop `futureField` and the semantics behind it.
    await expect(jobs.updateJob('session-1', { state: 'running' })).rejects.toThrow(/proto/i);
    await expect(jobs.writeJob(job('session-2', { proto: 3 }))).rejects.toThrow(/proto/i);
  });

  it('rebuilds the row set from disk when the roster is missing', async () => {
    // `roster.json` is a cache of "who is alive", not the source of truth. A
    // corrupt or absent one must not lose the user's jobs.
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    await jobs.writeJob(job('session-2'));
    await rm(jobs.rosterFile, { force: true });

    await expect(jobs.listJobs()).resolves.toEqual(['session-1', 'session-2']);
  });

  it('survives a corrupt roster by falling back to the job files', async () => {
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    await writeFile(jobs.rosterFile, '{ this is not json');

    await expect(jobs.listJobs()).resolves.toEqual(['session-1']);
  });

  it('ignores a directory in the jobs tree that is not a job', async () => {
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(jobs.jobsDir, 'not-a-job'), { recursive: true });

    await expect(jobs.listJobs()).resolves.toEqual(['session-1']);
  });

  it('appends timeline entries rather than rewriting them', async () => {
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    await jobs.appendTimeline('session-1', { at: 1, state: 'idle', detail: 'adopted' });
    await jobs.appendTimeline('session-1', { at: 2, state: 'running', detail: 'worker started' });

    const lines = (await readFile(jobs.timelineFile('session-1'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.state)).toEqual(['idle', 'running']);
  });

  it('keeps a timeline readable when one entry is malformed', async () => {
    // JSONL is append-only and a crash can land mid-line. One bad line must not
    // cost the whole crash-forensics record.
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    await writeFile(
      jobs.timelineFile('session-1'),
      ['{"at":1,"state":"idle"}', '{"at":2,"state":"trunc', ''].join('\n'),
    );
    await jobs.appendTimeline('session-1', { at: 3, state: 'running' });

    const entries = await jobs.readTimeline('session-1');
    expect(entries.map((entry) => entry.state)).toEqual(['idle', 'running']);
  });

  it('stages a pending message before it is delivered', async () => {
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    const id = await jobs.stagePending('session-1', { text: 'do the thing' });

    await expect(jobs.listPending('session-1')).resolves.toEqual([
      expect.objectContaining({ id, text: 'do the thing' }),
    ]);
  });

  it('delivers pending messages in the order they were staged', async () => {
    // A message that arrives while the worker is restarting must not overtake one
    // that was already accepted.
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    const first = await jobs.stagePending('session-1', { text: 'first' });
    const second = await jobs.stagePending('session-1', { text: 'second' });

    const pending = await jobs.listPending('session-1');
    expect(pending.map((entry) => entry.id)).toEqual([first, second]);
  });

  it('deletes a pending message only once it is acknowledged', async () => {
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    const id = await jobs.stagePending('session-1', { text: 'do the thing' });

    await jobs.resolvePending('session-1', id);
    await expect(jobs.listPending('session-1')).resolves.toEqual([]);
  });

  it('removes a job and everything under it', async () => {
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    await jobs.appendTimeline('session-1', { at: 1, state: 'idle' });
    await jobs.stagePending('session-1', { text: 'x' });

    await jobs.removeJob('session-1');

    await expect(jobs.readJob('session-1')).resolves.toBeUndefined();
    await expect(jobs.readTimeline('session-1')).resolves.toEqual([]);
    await expect(jobs.listJobs()).resolves.toEqual([]);
  });

  it('rejects a session id that would escape the jobs directory', async () => {
    // A session id reaches the daemon from a client. `../` in it would otherwise
    // let a caller write anywhere the user can. Every entry point throws rather
    // than returning "not found": a rejected id is a malformed caller, and
    // reporting it as a missing job hides the bug behind an empty row.
    const jobs = await store();
    for (const unsafe of ['../../escape', 'a/b', '..', '']) {
      await expect(jobs.writeJob(job(unsafe))).rejects.toThrow();
      await expect(jobs.readJob(unsafe)).rejects.toThrow();
      await expect(jobs.appendTimeline(unsafe, { at: 1, state: 'idle' })).rejects.toThrow();
      await expect(jobs.listPending(unsafe)).rejects.toThrow();
    }
  });

  it('leaves no temporary files behind after a write', async () => {
    const jobs = await store();
    await jobs.writeJob(job('session-1'));
    await jobs.updateJob('session-1', { state: 'running' });

    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(jobs.jobsDir, 'session-1'))).sort()).toEqual(['job.json']);
  });
});
