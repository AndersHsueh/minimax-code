import { describe, expect, it } from 'vitest';

import { describeTargetFailure, resolveSendTarget } from '../packages/tui/src/cli/session-target.js';
import type { TuiSession } from '../packages/tui/src/runtime/port.js';

/**
 * Who `mcode send` addresses.
 *
 * A session id is a 32-character hash. Making someone look one up before they
 * can send a message makes the command unusable, so the name given with
 * `/rename` is what the command takes, and this resolves it.
 *
 * A name that matches more than one session is refused. Guessing which one the
 * user meant would put the message in the wrong conversation, and nothing in
 * the transcript would show that it happened.
 */
function sessions(...list: Partial<TuiSession>[]): TuiSession[] {
  return list.map((session, index) => ({
    sessionId: `mvs_${String(index).padStart(32, '0')}`,
    ...session,
  })) as TuiSession[];
}

function resolver(list: TuiSession[]) {
  return { listSessions: async () => ({ sessions: list }) };
}

describe('session target', () => {
  it('resolves a name to its session and workspace', async () => {
    const target = await resolveSendTarget('docs-review', {
      ...resolver(
        sessions(
          { title: 'other', workspaceDir: '/tmp/a' },
          { title: 'docs-review', workspaceDir: '/tmp/docs' },
        ),
      ),
    });
    expect(target).toMatchObject({
      kind: 'session',
      sessionId: 'mvs_00000000000000000000000000000001',
      workspaceDir: '/tmp/docs',
      title: 'docs-review',
    });
  });

  it('refuses a name that more than one session has', async () => {
    const target = await resolveSendTarget('dupe', {
      ...resolver(
        sessions(
          { title: 'dupe', workspaceDir: '/tmp/a' },
          { title: 'dupe', workspaceDir: '/tmp/b' },
        ),
      ),
    });
    expect(target.kind).toBe('ambiguous');
    if (target.kind !== 'ambiguous') return;
    expect(target.matches).toHaveLength(2);
    // The message says what to do about it, not merely that it went wrong.
    expect(describeTargetFailure(target)).toContain('Rename one');
  });

  it('reports an unknown name and lists the names that do exist', async () => {
    const target = await resolveSendTarget('nope', {
      ...resolver(sessions({ title: 'alpha' }, { title: 'beta' })),
    });
    expect(target.kind).toBe('unknown');
    if (target.kind !== 'unknown') return;
    expect(target.available).toEqual(['alpha', 'beta']);
    expect(describeTargetFailure(target)).toContain('alpha');
  });

  it('accepts a session id even when no session carries it', async () => {
    // Scripts and `--json` output have a machine in the loop; refusing the only
    // handle that never depends on a name existing would break them.
    const target = await resolveSendTarget('mvs_ffffffffffffffffffffffffffffffff', {
      ...resolver(sessions({ title: 'alpha' })),
    });
    expect(target).toMatchObject({
      kind: 'session',
      sessionId: 'mvs_ffffffffffffffffffffffffffffffff',
    });
  });

  it('ignores an unnamed session when a name is given', async () => {
    // Sessions created by a tool or a crash have no title. Matching on an
    // absent title would make every such session collide on "".
    const target = await resolveSendTarget('', {
      ...resolver(sessions({ title: undefined }, { title: undefined })),
    });
    expect(target.kind).toBe('unknown');
  });

  it('does not treat a name as a prefix of another name', async () => {
    const target = await resolveSendTarget('doc', {
      ...resolver(sessions({ title: 'docs' }, { title: 'docs-2' })),
    });
    expect(target.kind).toBe('unknown');
  });
});
