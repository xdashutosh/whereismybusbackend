// Public surface of the students module for other modules (parent app, tracking, notifications,
// reports). Every helper runs inside the caller's transaction and reads the CURRENT school
// through RLS (parent contexts see only their own linked children).
//   effectiveAssignments(tx, studentId)   current + upcoming assignment rows with display names
//   validateAssignmentTarget(tx, …)       the bus → route → stop rules of PUT …/assignment
export { effectiveForStudent as effectiveAssignments } from './assignmentsRepository.js';
export { validateTarget as validateAssignmentTarget } from './assignmentsService.js';
export { byDirection, toAssignmentDto, type AssignmentJson } from './dto.js';
