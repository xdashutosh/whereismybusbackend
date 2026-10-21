import { describe, expect, it } from 'vitest';
import * as root from './index.js';
import * as enums from './enums.js';
import * as api from './api.js';
import * as schemas from './schemas/index.js';

// The package entry ('@wimb/shared') must re-export every runtime value of the subpath entries
// ('@wimb/shared/enums', '/api', '/schemas') without name clashes between them.
describe('package entry', () => {
  it.each([
    ['enums', enums],
    ['api', api],
    ['schemas', schemas],
  ] as const)('re-exports every value of %s', (_name, mod) => {
    for (const [key, value] of Object.entries(mod)) expect(root[key as keyof typeof root], key).toBe(value);
  });

  it('has no runtime exports beyond the subpath entries', () => {
    const fromSubpaths = new Set([...Object.keys(enums), ...Object.keys(api), ...Object.keys(schemas)]);
    expect(Object.keys(root).filter((k) => !fromSubpaths.has(k))).toEqual([]);
  });

  it('exports names that are not repeated across the subpath entries', () => {
    const keys = [...Object.keys(enums), ...Object.keys(api), ...Object.keys(schemas)];
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });
});
