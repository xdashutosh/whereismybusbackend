// Request schemas of the buses module. Body/query schemas are shared with the web admin
// (@wimb/shared → shared/src/schemas/buses.ts); path params live here.
import { uuid } from '@wimb/shared';
import { z } from 'zod';

export {
  addBusImageBody,
  assignmentHistoryQuery,
  assignStaffBody,
  busDocumentsQuery,
  busDocumentVisibilityBody,
  busListQuery,
  busStatusBody,
  createBusBody,
  createBusDocumentBody,
  reorderBusImagesBody,
  replaceBusDocumentBody,
  updateBusBody,
  updateBusDocumentBody,
  updateBusImageBody,
  verifyBusDocumentBody,
  type AddBusImageBody,
  type AssignmentHistoryQuery,
  type AssignStaffBody,
  type BusDocumentsQuery,
  type BusDocumentVisibilityBody,
  type BusListQuery,
  type BusStatusBody,
  type CreateBusBody,
  type CreateBusDocumentBody,
  type ReorderBusImagesBody,
  type ReplaceBusDocumentBody,
  type UpdateBusBody,
  type UpdateBusDocumentBody,
  type UpdateBusImageBody,
  type VerifyBusDocumentBody,
} from '@wimb/shared';

export const busParams = z.object({ id: uuid() });
export type BusParams = z.infer<typeof busParams>;

export const busImageParams = z.object({ id: uuid(), imageId: uuid() });
export type BusImageParams = z.infer<typeof busImageParams>;

export const busDocumentParams = z.object({ docId: uuid() });
export type BusDocumentParams = z.infer<typeof busDocumentParams>;
