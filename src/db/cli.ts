// CLI entry detection for scripts runnable with tsx (src/*.ts) or node (dist/*.js).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when the module at `moduleUrl` is the process entry point. */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(moduleUrl);
  const resolved = path.resolve(entry);
  const strip = (p: string) => p.replace(/\.(ts|js|mjs|cjs)$/, '');
  return resolved === self || strip(resolved) === strip(self);
}
