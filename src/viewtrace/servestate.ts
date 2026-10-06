/**
 * Collector-service state files under the data root (M1).
 *
 *   <root>/service.json — { protocolVersion, pid, bootId, port, token, startedAt }
 *                          written atomically (0600) by the live service.
 *   <root>/service.lock — exclusive boot mutex; contains the owner pid.
 *
 * Identity rule: a service.json entry only describes a *running* collector
 * when (a) its pid is alive, (b) the control endpoint answers with the same
 * pid AND bootId and accepts the token from the file. Anything else is stale
 * state that `up`/`status` must diagnose — never a reason to kill a pid
 * blindly (PID reuse).
 */

import { open, readFile, rename, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

export const SERVICE_PROTOCOL_VERSION = 1;

export interface ServiceFileInfo {
  readonly protocolVersion: number;
  readonly pid: number;
  readonly bootId: string;
  readonly port: number;
  readonly token: string;
  readonly startedAt: string;
}

export function serviceFile(dataRoot: string): string {
  return join(dataRoot, 'service.json');
}
export function serviceLockFile(dataRoot: string): string {
  return join(dataRoot, 'service.lock');
}
export function liveDir(dataRoot: string): string {
  return join(dataRoot, 'live');
}
export function logsDir(dataRoot: string): string {
  return join(dataRoot, 'logs');
}
export function serviceLog(dataRoot: string): string {
  return join(logsDir(dataRoot), 'service.log');
}

export function parseServiceJson(text: string): ServiceFileInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;
  const { protocolVersion, pid, bootId, port, token, startedAt } = raw;
  if (
    typeof protocolVersion !== 'number' || protocolVersion !== SERVICE_PROTOCOL_VERSION ||
    typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 ||
    typeof bootId !== 'string' || bootId.length === 0 ||
    typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535 ||
    typeof token !== 'string' || token.length < 32 ||
    typeof startedAt !== 'string' || startedAt.length === 0
  ) {
    return null;
  }
  return { protocolVersion, pid, bootId, port, token, startedAt };
}

export async function readServiceFile(dataRoot: string): Promise<ServiceFileInfo | null> {
  let text: string;
  try {
    text = await readFile(serviceFile(dataRoot), 'utf8');
  } catch {
    return null;
  }
  return parseServiceJson(text);
}

export async function writeServiceFile(dataRoot: string, info: ServiceFileInfo): Promise<void> {
  // Unique tmp name: concurrent writers (heartbeat + `up` repair) must not
  // steal each other's rename source.
  const tmp = `${serviceFile(dataRoot)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(info, null, 2) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, serviceFile(dataRoot));
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function removeServiceFile(dataRoot: string): Promise<void> {
  await rm(serviceFile(dataRoot), { force: true });
}

/** true when a process with this pid exists (EPERM still means "exists"). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LockResult = 'acquired' | 'busy';

/**
 * Exclusive boot mutex. The lock holds the owner pid; a lock whose pid is
 * dead (and whose service.json does not answer) is stale and gets stolen.
 */
export async function acquireServiceLock(dataRoot: string): Promise<LockResult> {
  const lockPath = serviceLockFile(dataRoot);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(`${process.pid}\n`);
      } finally {
        await handle.close();
      }
      return 'acquired';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let heldPid = 0;
    try {
      const text = await readFile(lockPath, 'utf8');
      const parsed = Number(text.trim());
      if (Number.isInteger(parsed)) heldPid = parsed;
    } catch {
      heldPid = 0;
    }
    if (heldPid !== 0 && pidAlive(heldPid)) return 'busy';
    await rm(lockPath, { force: true });
  }
  return 'busy';
}

export async function releaseServiceLock(dataRoot: string): Promise<void> {
  const lockPath = serviceLockFile(dataRoot);
  try {
    const text = await readFile(lockPath, 'utf8');
    if (Number(text.trim()) === process.pid) await rm(lockPath, { force: true });
  } catch {
    /* not held by us — leave it alone */
  }
}
