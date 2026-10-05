import { rename, rm, stat } from 'node:fs/promises';

/**
 * Rotates a log once it passes `maxBytes`, keeping exactly one previous file.
 *
 * A daemon is designed to outlive the terminals that started it and to be
 * restarted rarely, so nothing else would ever bound its log. One generation is
 * enough: the previous run's tail is what someone reads after a crash.
 */
export async function rotateDaemonLog(file: string, maxBytes: number): Promise<boolean> {
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;
  await rm(`${file}.1`, { force: true });
  await rename(file, `${file}.1`);
  return true;
}
