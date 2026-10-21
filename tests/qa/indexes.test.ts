// Hot-path indexes added after the scale run (lane B migrations 850–899).
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, ownerQuery } from '../helpers/db.js';

afterAll(closeDb);

describe('alerts dedupe history index (851)', () => {
  it('serves "was this dedupe key ever raised?" lookups for alerts in any status', async () => {
    const { rows } = await ownerQuery<{ def: string }>("select indexdef as def from pg_indexes where tablename = 'alerts' and indexname = 'alerts_school_dedupe_key_idx'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.def).toMatch(/\(school_id, dedupe_key\) WHERE \(dedupe_key IS NOT NULL\)/);
    // Unlike alerts_dedupe (open/escalated only), the predicate does not depend on the status.
    expect(rows[0]!.def).not.toMatch(/status/);
  });
});
