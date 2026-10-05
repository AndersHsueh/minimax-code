/** JSON-RPC 2.0 over ndjson — the same framing ACP uses, so worker traffic can be
 *  forwarded byte for byte instead of transcoded. Length-prefixed `auth-lease`
 *  framing is the documented alternative; the two are never mixed. */
export const DAEMON_PROTO = 1;

/** ndjson carries no length prefix, so a line cap is the only bound on a frame. */
export const DAEMON_MAX_FRAME_BYTES = 1024 * 1024;

export const DAEMON_DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export interface DaemonRequestFrame {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface DaemonResponseFrame {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export const DAEMON_ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  unauthorized: -32001,
  internal: -32603,
} as const;

export function serializeFrame(frame: DaemonResponseFrame | DaemonRequestFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function isRequestFrame(value: unknown): value is DaemonRequestFrame {
  if (!isRecord(value)) return false;
  return value.jsonrpc === '2.0' && typeof value.method === 'string' && 'id' in value;
}

/**
 * True for a response frame: an `id` with no `method`.
 *
 * Needed because a request and a response look alike otherwise, and a client
 * that treats every frame as a request silently discards every reply.
 */
export function isResponseFrame(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.jsonrpc === '2.0' && 'id' in value && typeof value.method !== 'string';
}

export interface DaemonNotificationFrame {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

/**
 * True for a server-initiated frame: a `method` and no `id`.
 *
 * The footer's awaiting badge is fed by these, and the distinction is not
 * cosmetic. Both existing predicates reject a notification — `isRequestFrame`
 * wants an `id`, `isResponseFrame` wants no `method` — so a client written
 * against the other two silently discards every push. The `id` check is also
 * what keeps the `hello` handshake out: that is a request, and a handler that
 * treated it as a push would act on a frame still awaiting its reply.
 */
export function isNotificationFrame(value: unknown): value is DaemonNotificationFrame {
  if (!isRecord(value)) return false;
  return value.jsonrpc === '2.0' && typeof value.method === 'string' && !('id' in value);
}

/**
 * Splits a growing buffer into complete frames.
 *
 * Returns the frames it could parse plus whatever is left over. A line that
 * exceeds {@link DAEMON_MAX_FRAME_BYTES} is reported as `oversized` so the caller
 * can drop the connection — buffering an unbounded line is how a daemon runs out
 * of memory from one client.
 */
export function drainNdjsonBuffer(
  buffer: string,
): { frames: unknown[]; rest: string; oversized: boolean } {
  const frames: unknown[] = [];
  let rest = buffer;
  let oversized = false;
  for (;;) {
    const newline = rest.indexOf('\n');
    if (newline < 0) break;
    const line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > DAEMON_MAX_FRAME_BYTES) {
      oversized = true;
      continue;
    }
    try {
      frames.push(JSON.parse(line));
    } catch {
      frames.push({ __parseError: true });
    }
  }
  if (Buffer.byteLength(rest) > DAEMON_MAX_FRAME_BYTES) {
    oversized = true;
    rest = '';
  }
  return { frames, rest, oversized };
}

export function errorFrame(
  id: number | string | null,
  code: number,
  message: string,
): DaemonResponseFrame {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function resultFrame(id: number | string | null, result: unknown): DaemonResponseFrame {
  return { jsonrpc: '2.0', id, result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
