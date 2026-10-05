export interface AgentRow {
  readonly sessionId: string;
  readonly name?: string;
  readonly state: string;
  readonly summary?: string;
  readonly lane?: string;
}

/** Marks that mean something to the reader at a glance; `∙` is not an error. */
const STATE_MARKS: Record<string, string> = {
  working: '✽',
  'needs-input': '✻',
  idle: '✻',
  completed: '∙',
  failed: '∙',
  stopped: '∙',
};

/**
 * The `mcode agents` listing.
 *
 * `∙` is a normal resting state, not a failure, and the text says so: a user
 * reading a column of dots should not have to guess whether anything broke. The
 * JSON form is the machine-readable one and carries no decoration, so a script
 * never has to parse a glyph.
 */
export function buildAgentsReport(rows: readonly AgentRow[], json: boolean): string {
  if (json) return `${JSON.stringify(rows, null, 2)}\n`;
  if (rows.length === 0) return 'No background agents are running.\n';
  const lines = rows.map((row) => {
    const mark = STATE_MARKS[row.state] ?? '·';
    const name = row.name ?? row.sessionId;
    const summary = row.summary ? ` — ${row.summary}` : '';
    return `  ${mark} ${name}  ${row.state}${summary}`;
  });
  return `${['Background agents:', ...lines].join('\n')}\n`;
}

/**
 * `mcode send <id> "message"`.
 *
 * The message is required rather than defaulted: sending an empty prompt would
 * wake a worker and leave it waiting for something that never arrives, which
 * looks exactly like a hung job.
 */
export function parseSendRequest(argv: readonly string[]): {
  sessionId: string;
  text: string;
} {
  const [sessionId, ...rest] = argv;
  if (!sessionId || sessionId.startsWith('-')) {
    throw new Error('Usage: mcode send <session-id> "message"');
  }
  const text = rest.join(' ').trim();
  if (!text) {
    throw new Error('mcode send needs a message. Usage: mcode send <session-id> "message"');
  }
  return { sessionId, text };
}
