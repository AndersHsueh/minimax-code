import { prepareTuiDataDir } from '../runtime/data-dir.js';
import { createTuiRuntime, shutdownTuiRuntime } from '../runtime/lifecycle.js';
import type { TuiSession } from '../runtime/port.js';

/**
 * Resolves the `<target>` a user typed into a session, for `mcode send`.
 *
 * A session id is a 32-character hash nobody can hold in their head, so asking
 * someone to look one up before sending a message makes the command unusable in
 * practice. The name a person gives a session with `/rename` is the thing they
 * can actually type, so that is what the command takes.
 *
 * The lookup lives on the client side, never in the daemon: the daemon must not
 * open the runtime DB (its whole state lives in `<dataDir>/daemon/`), and it
 * only ever needs a session id, which is what the client hands it.
 *
 * A title that matches more than one session is refused rather than resolved to
 * a guess. Sending a message into the wrong session is worse than making someone
 * rename one.
 */

/** `mvs_` plus the 32-character hash the runtime mints for every session. */
const SESSION_ID = /^mvs_[0-9a-f]{32}$/;

export type SendTarget =
  | {
      readonly kind: 'session';
      readonly sessionId: string;
      /** Absent for a bare session id that was never listed; the daemon defaults it. */
      readonly workspaceDir?: string;
      readonly title?: string;
    }
  | {
      readonly kind: 'ambiguous';
      readonly title: string;
      readonly matches: readonly { readonly sessionId: string; readonly workspaceDir?: string }[];
    }
  | { readonly kind: 'unknown'; readonly query: string; readonly available: readonly string[] };

export interface ResolveSendTargetDependencies {
  readonly listSessions: (input: {
    agentName?: string;
    cursor?: string;
    limit?: number;
    includeArchived?: boolean;
  }) => Promise<{ sessions: TuiSession[]; hasMore?: boolean; nextCursor?: string }>;
}

export async function resolveSendTarget(
  query: string,
  dependencies?: Partial<ResolveSendTargetDependencies>,
): Promise<SendTarget> {
  const trimmed = query.trim();
  if (!trimmed) return { kind: 'unknown', query, available: [] };

  const sessions = await listAll(dependencies);

  // Exact title match wins over everything: it is what the user asked for.
  const titled = sessions.filter(
    (session) => (session.title ?? '').trim() === trimmed && session.title !== undefined,
  );
  if (titled.length > 1) {
    return {
      kind: 'ambiguous',
      title: trimmed,
      matches: titled.map((session) => ({
        sessionId: session.sessionId,
        ...(session.workspaceDir ? { workspaceDir: session.workspaceDir } : {}),
      })),
    };
  }
  if (titled.length === 1) {
    const only = titled[0]!;
    return {
      kind: 'session',
      sessionId: only.sessionId,
      ...(only.workspaceDir ? { workspaceDir: only.workspaceDir } : {}),
      ...(only.title ? { title: only.title } : {}),
    };
  }

  // A session id is still accepted: scripts, `--json` output and debugging all
  // have a machine in the loop, and refusing it would remove the only handle
  // that never depends on a title existing.
  if (SESSION_ID.test(trimmed)) {
    const known = sessions.find((session) => session.sessionId === trimmed);
    return {
      kind: 'session',
      sessionId: trimmed,
      ...(known?.workspaceDir ? { workspaceDir: known.workspaceDir } : {}),
      ...(known?.title ? { title: known.title } : {}),
    };
  }

  return {
    kind: 'unknown',
    query: trimmed,
    available: sessions
      .map((session) => (session.title ?? '').trim())
      .filter((title) => title.length > 0)
      .slice(0, 20),
  };
}

async function listAll(
  dependencies?: Partial<ResolveSendTargetDependencies>,
): Promise<TuiSession[]> {
  if (dependencies?.listSessions) {
    return (await dependencies.listSessions({ limit: 200, includeArchived: false })).sessions;
  }
  const dataDir = await prepareTuiDataDir();
  const runtime = await createTuiRuntime({
    dataDir,
    workspaceDir: process.cwd(),
    version: '0.0.0',
    surface: 'headless',
    promptMode: 'tui',
    permissionMode: 'default',
  });
  try {
    const page = await runtime.adapter.listSessionPage({ limit: 200, includeArchived: false });
    return page.sessions;
  } finally {
    // The runtime owns watchers and subprocesses; a `send` that leaves them
    // behind would keep the CLI process alive after the message is gone.
    await shutdownTuiRuntime(runtime).catch(() => undefined);
  }
}

/** One line per unresolved target, written to stderr by the command. */
export function describeTargetFailure(target: SendTarget): string {
  if (target.kind === 'session') return target.sessionId;
  if (target.kind === 'ambiguous') {
    const lines = target.matches.map((match) => `  ${match.sessionId}`).join('\n');
    return `${target.matches.length} sessions are named "${target.title}". Rename one, or pass its session id:\n${lines}`;
  }
  if (target.available.length > 0) {
    return `No session is named "${target.query}". Named sessions: ${target.available.join(', ')}`;
  }
  return `No session is named "${target.query}", and no session has a name yet. Give one a name with /rename.`;
}
