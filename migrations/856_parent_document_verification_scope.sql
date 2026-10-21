-- Parent scope (lane B range 850–899): BP §12/§13.3, docs/api/buses.md + staff.md "Verification".
-- The application shows parents only CURRENT, not deleted, VERIFIED documents (and their files);
-- the RLS backstop from 011 still let a parent read pending/rejected document rows and the files
-- attached to them. Tightened here so the database enforces the same rule:
--   * bus_documents: current, not deleted, verified, with a parent flag (the parent bus view has
--     no "not verified" state — unverified bus documents are simply left out).
--   * staff_documents: current, not deleted, non-identity, and either verified with a parent flag,
--     or (any verification) with visible_to_parents_status — the staff card lists a pending or
--     rejected document whose status the flags allow as "not verified" (status only: the API sends
--     no validity and no file for it). A file-only document that is not verified is hidden.
--   * files: a bus/staff document file only when that document is verified and its file flag is on
--     (the sub-selects run under the document tables' own RLS, so current/not deleted also apply).
select apply_parent_scope('bus_documents',
  $p$is_current and deleted_at is null and verification_status = 'verified'
     and (visible_to_parents_status or visible_to_parents_file)
     and bus_id in (select b.id from buses b)$p$);

select apply_parent_scope('staff_documents',
  $p$is_current and deleted_at is null and doc_type <> 'identity'
     and (visible_to_parents_status or (visible_to_parents_file and verification_status = 'verified'))
     and staff_id in (select sp.id from staff_profiles sp)$p$);

select apply_parent_scope('files',
  $p$status = 'uploaded' and case category
       when 'school_logo' then true
       when 'bus_image' then id in (select bi.file_id from bus_images bi)
       when 'bus_document' then id in (select bd.file_id from bus_documents bd
                                        where bd.visible_to_parents_file and bd.verification_status = 'verified')
       when 'staff_photo' then id in (select sp.photo_file_id from staff_profiles sp)
       when 'staff_document' then id in (select sd.file_id from staff_documents sd
                                          where sd.visible_to_parents_file and sd.verification_status = 'verified')
       when 'student_photo' then id in (select s.photo_file_id from students s)
       else false end$p$);
