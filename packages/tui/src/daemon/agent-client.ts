import { connectDaemon, type DaemonClient } from './client.js';
import { readCapabilityFile } from './capability.js';
import { daemonPaths } from './paths.js';
import { buildAgentsReport, type AgentRow } from './agents-cli.js';

export interface AgentClientOptions {
  readonly dataDir: string;
  readonly version: string;
}

/**
 * Connects as a CLI client.
 *
 * No token in the environment, no database handle, no runtime: the CLI reads the
 * daemon's own view over the socket. A client that cannot reach a daemon gets a
 * clear "not running" rather than a stack trace, because these are the commands
 * people run when something looks wrong.
 */
async function withDaemonClient<T>(
  options: AgentClientOptions,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T | { readonly rejected: string }> {
  const paths = daemonPaths(options.dataDir);
  let token: string;
  try {
    token = await readCapabilityFile(paths.capabilityFile);
  } catch {
    return { rejected: 'no daemon is running for this data directory' };
  }
  const client = await connectDaemon({
    socketFile: paths.socketFile,
    token,
    version: options.version,
    kind: 'cli',
  }).catch(() => undefined);
  if (!client) {
    return { rejected: `a token exists but nothing is listening on ${paths.socketFile}` };
  }
  try {
    return await run(client);
  } catch (error) {
    return { rejected: error instanceof Error ? error.message : String(error) };
  } finally {
    client.close();
  }
}

/**
 * `mcode agents`.
 *
 * A job with no worker is never started to answer this. The row comes from the
 * daemon's last recorded view, because "the process is a cache" means the
 * interesting state outlives the process that produced it.
 */
export type AgentsQueryResult =
  | { readonly ok: true; readonly rows: AgentRow[] }
  | { readonly ok: false; readonly reason: string };

export async function runAgentClientQuery(
  options: AgentClientOptions & { includeEnded?: boolean },
): Promise<AgentsQueryResult> {
  const result = await withDaemonClient(options, (client) =>
    client.request('jobs.list', { includeEnded: options.includeEnded === true }),
  );
  // "No daemon" and "no jobs" are different answers to different questions.
  // Collapsing them makes a stopped daemon look like a quiet one.
  if (result === null || typeof result !== 'object') {
    return { ok: false, reason: 'unknown daemon reply' };
  }
  const record = result as { rejected?: string; jobs?: AgentRow[] };
  if (typeof record.rejected === 'string') return { ok: false, reason: record.rejected };
  return { ok: true, rows: record.jobs ?? [] };
}

export interface AgentCommandReport {
  readonly rejected?: string;
  readonly delivered?: boolean;
  readonly stopped?: boolean;
  readonly staged?: boolean;
  readonly reason?: string;
}

/** `mcode send` / `mcode stop`. */
export async function runAgentClientCommand(
  options: AgentClientOptions & { method: string; params: unknown },
): Promise<AgentCommandReport> {
  const result = await withDaemonClient<AgentCommandReport>(options, (client) =>
    client.request(options.method, options.params) as Promise<AgentCommandReport>,
  );
  return result ?? {};
}

export { buildAgentsReport };
