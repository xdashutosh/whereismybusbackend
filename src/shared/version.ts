// Semantic version comparison for app version gating (contract §9).
const RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseVersion(v: unknown): ParsedVersion | null {
  if (typeof v !== 'string') return null;
  const m = RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? null };
}

/** -1 / 0 / 1; a pre-release sorts before its release (1.2.0-beta < 1.2.0). Throws on invalid input. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new TypeError(`Invalid version: ${!x ? a : b}`);
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.prerelease === y.prerelease) return 0;
  if (x.prerelease === null) return 1;
  if (y.prerelease === null) return -1;
  return x.prerelease < y.prerelease ? -1 : 1;
}
