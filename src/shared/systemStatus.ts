// System status registry: operational signals that are not readiness failures (e.g. the SMS credit
// balance). Producers register a named check at import time; the platform module's health view
// reads them with getSystemStatus() (Super Admin dashboard, BP §7.1). Unlike /readyz checks, a
// degraded status never takes the instance out of rotation.
export type StatusLevel = 'ok' | 'warn' | 'error';

export interface StatusCheckResult {
  level: StatusLevel;
  message?: string;
  details?: Record<string, unknown>;
}

export type StatusCheck = () => Promise<StatusCheckResult>;

const checks = new Map<string, StatusCheck>();

/** Registers (or replaces) a named status check. */
export function registerStatusCheck(name: string, check: StatusCheck): void {
  checks.set(name, check);
}

export function unregisterStatusCheck(name: string): void {
  checks.delete(name);
}

export function statusCheckNames(): string[] {
  return [...checks.keys()];
}

/** Runs every registered check; a throwing check reports level 'error' (message only). */
export async function getSystemStatus(): Promise<{ level: StatusLevel; checks: Record<string, StatusCheckResult> }> {
  const entries = await Promise.all(
    [...checks.entries()].map(async ([name, check]): Promise<[string, StatusCheckResult]> => {
      try {
        return [name, await check()];
      } catch (err) {
        return [name, { level: 'error', message: err instanceof Error ? err.message : 'CHECK_FAILED' }];
      }
    }),
  );
  const levels = entries.map(([, r]) => r.level);
  const level: StatusLevel = levels.includes('error') ? 'error' : levels.includes('warn') ? 'warn' : 'ok';
  return { level, checks: Object.fromEntries(entries) };
}
