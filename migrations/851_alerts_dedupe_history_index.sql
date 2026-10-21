-- Alerts (lane B range 850–899): index for "was this dedupe key EVER raised?" checks.
--
-- raiseAlert(..., once: true) and the trip-not-started overdue query look for an alert with a given
-- dedupe_key in ANY status. alerts_dedupe (migration 008) is partial (status open/escalated), so those
-- lookups fell back to alerts_school_created_idx and filtered the school's whole alert history — linear
-- in the number of alerts and run per raised alert in every scan and every minute per school.
-- This index serves them for closed/reviewed alerts too. Grants: db:setup-roles (indexes need none).
create index if not exists alerts_school_dedupe_key_idx
  on alerts (school_id, dedupe_key)
  where dedupe_key is not null;
