// File authorization hooks for student photos (BP §12, docs/api/files.md).
//   school_admin      every uploaded file of the school (files module default)
//   driver/conductor  none — student photos are not shown in the driver app
//   parent            the photo currently set on a live, active student linked to that parent.
//                     school_settings.parent_visibility has no student section (it governs bus
//                     and staff details), so a parent always sees their own child's photo and
//                     never anyone else's.
// RLS parent_scope on files/students/student_parents is the backstop. Registered once at import
// (router.ts imports this module).
import { registerFileHooks, type ReadHookContext } from '../files/hooks.js';

export async function parentMayReadStudentPhoto({ tx, auth, file }: ReadHookContext): Promise<boolean> {
  const row = await tx.maybeOne(
    `select 1 from students s
       join student_parents l on l.student_id = s.id and l.parent_account_id = $2
      where s.photo_file_id = $1 and s.deleted_at is null and s.is_active`,
    [file.id, auth.actorId],
  );
  return row !== null;
}

registerFileHooks('student_photo', { parentRead: parentMayReadStudentPhoto });
