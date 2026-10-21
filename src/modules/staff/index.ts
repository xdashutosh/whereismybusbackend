// Public surface of the staff module for other modules (parent app staff cards, dashboards, jobs).
//   parentStaffCard(req, tx, staffId)  one driver/conductor card as a parent sees it (parent context)
//   parentStaffForBus(req, tx, busId)  cards of the staff currently assigned to a bus, with their role
//   parentSees*                        document visibility rules (school matrix + document flags;
//                                      validity and files only for current, verified documents)
export {
  buildParentCard,
  hiddenDocumentReason,
  loadStaffMatrix,
  parentSeesStaffDocument,
  parentSeesStaffDocumentAsNotVerified,
  parentSeesStaffDocumentFile,
  parentSeesStaffDocumentStatus,
  parentStaffCard,
  parentStaffForBus,
  sectionOf,
} from './visibility.js';
export type { ParentProfileRow, StaffMatrix } from './visibility.js';
