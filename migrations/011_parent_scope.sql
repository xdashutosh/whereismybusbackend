-- 011 · Parent scope (BP §4.3, §15.3; contract §4). RESTRICTIVE policies narrowing what
-- actor_role = 'parent' sees inside its validated school context. Tenant isolation still applies
-- first, so every predicate below is already limited to app.school_id. Sub-selects run under the
-- referenced table's own RLS (that is how visibility chains: a parent's buses are the buses of its
-- children's live assignments, its staff are the staff currently assigned to those buses, …).
-- A = the parent's account id. Read-only unless the third argument is true. 'false' = hidden.
-- Every table with school_id must appear here (the RLS catalog test enforces it).

-- Hidden from parents
select apply_parent_scope('users', 'false');
select apply_parent_scope('school_subscriptions', 'false');
select apply_parent_scope('trip_odometer_evidence', 'false');
select apply_parent_scope('alerts', 'false');
select apply_parent_scope('fuel_logs', 'false');
select apply_parent_scope('maintenance_logs', 'false');
select apply_parent_scope('notification_events', 'false');

-- School-wide, read-only
select apply_parent_scope('school_settings', 'true');
select apply_parent_scope('school_holidays', 'true');
select apply_parent_scope('announcements',
  $p$deleted_at is null and audience in ('parents', 'all') and published_at <= now() and (expires_at is null or expires_at > now())$p$);

-- The parent's own profile in this school and its links
select apply_parent_scope('school_parents',
  $p$parent_account_id = nullif(current_setting('app.actor_id', true), '')::uuid$p$);
select apply_parent_scope('student_parents',
  $p$parent_account_id = nullif(current_setting('app.actor_id', true), '')::uuid
     and exists (select 1 from school_parents sp
                 where sp.school_id = student_parents.school_id
                   and sp.parent_account_id = student_parents.parent_account_id
                   and sp.is_active and sp.deleted_at is null)$p$);
select apply_parent_scope('students',
  $p$deleted_at is null and is_active and id in (select sp.student_id from student_parents sp)$p$);
select apply_parent_scope('student_assignments',
  $p$valid_from <= (select app_local_date()) and (valid_to is null or valid_to > (select app_local_date()))
     and student_id in (select s.id from students s)$p$);

-- Assigned fleet and routes
select apply_parent_scope('buses',
  $p$deleted_at is null and id in (select sa.bus_id from student_assignments sa)$p$);
select apply_parent_scope('bus_images',
  $p$bus_id in (select b.id from buses b)$p$);
select apply_parent_scope('bus_documents',
  $p$is_current and deleted_at is null and (visible_to_parents_status or visible_to_parents_file)
     and bus_id in (select b.id from buses b)$p$);
select apply_parent_scope('bus_staff_assignments',
  $p$valid_from <= now() and (valid_to is null or valid_to > now()) and bus_id in (select b.id from buses b)$p$);
select apply_parent_scope('bus_route_assignments',
  $p$valid_from <= now() and (valid_to is null or valid_to > now()) and bus_id in (select b.id from buses b)$p$);
select apply_parent_scope('trip_schedules',
  $p$deleted_at is null and bus_id in (select b.id from buses b)$p$);
select apply_parent_scope('routes',
  $p$deleted_at is null and id in (select sa.route_id from student_assignments sa)$p$);
select apply_parent_scope('stops',
  $p$deleted_at is null and route_id in (select r.id from routes r)$p$);

-- Staff currently assigned to those buses and their parent-visible documents
select apply_parent_scope('staff_profiles',
  $p$deleted_at is null and is_active and id in (select bsa.staff_id from bus_staff_assignments bsa)$p$);
select apply_parent_scope('staff_documents',
  $p$is_current and deleted_at is null and doc_type <> 'identity' and (visible_to_parents_status or visible_to_parents_file)
     and staff_id in (select sp.id from staff_profiles sp)$p$);

-- School trips of the assigned bus in the assigned direction; live positions of running trips only
select apply_parent_scope('trips',
  $p$trip_type = 'school' and (bus_id, direction) in (select sa.bus_id, sa.trip_direction from student_assignments sa)$p$);
select apply_parent_scope('location_points',
  $p$trip_id in (select t.id from trips t where t.status = 'in_progress')$p$);
select apply_parent_scope('trip_stop_events',
  $p$trip_id in (select t.id from trips t)$p$);

-- Files: only those attached to something the parent may see (school logo, bus images, staff/student
-- photos, documents whose file is parent-visible)
select apply_parent_scope('files',
  $p$status = 'uploaded' and case category
       when 'school_logo' then true
       when 'bus_image' then id in (select bi.file_id from bus_images bi)
       when 'bus_document' then id in (select bd.file_id from bus_documents bd where bd.visible_to_parents_file)
       when 'staff_photo' then id in (select sp.photo_file_id from staff_profiles sp)
       when 'staff_document' then id in (select sd.file_id from staff_documents sd where sd.visible_to_parents_file)
       when 'student_photo' then id in (select s.photo_file_id from students s)
       else false end$p$);

-- The parent's own rows (writable)
select apply_parent_scope('notification_preferences',
  $p$parent_account_id = nullif(current_setting('app.actor_id', true), '')::uuid and student_id in (select s.id from students s)$p$, true);
select apply_parent_scope('parent_notifications',
  $p$parent_account_id = nullif(current_setting('app.actor_id', true), '')::uuid$p$, true);
select apply_parent_scope('devices',
  $p$owner_type = 'parent_account' and owner_id = nullif(current_setting('app.actor_id', true), '')::uuid$p$, true);
select apply_parent_scope('sessions',
  $p$owner_type = 'parent_account' and owner_id = nullif(current_setting('app.actor_id', true), '')::uuid$p$, true);
select apply_parent_scope('idempotency_keys',
  $p$actor_id = nullif(current_setting('app.actor_id', true), '')::uuid$p$, true);
-- audit_logs: parents may append (their own actions are audited) but never read — see the
-- restrictive audit_readers policy in 010.
