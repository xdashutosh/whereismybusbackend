// HTTP layer of the buses module: read req.valid, call the service, send the envelope.
import type { Request, Response } from 'express';
import { created, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import * as assignments from './assignmentsService.js';
import * as documents from './documentsService.js';
import * as images from './imagesService.js';
import type * as s from './schemas.js';
import * as service from './service.js';

const busId = (req: Request) => validated<s.BusParams>(req, 'params').id;
const docId = (req: Request) => validated<s.BusDocumentParams>(req, 'params').docId;

// ── buses ────────────────────────────────────────────────────────────────────
export const list = (req: Request, res: Response) => service.list(req, res, validated<s.BusListQuery>(req, 'query'));
export async function get(req: Request, res: Response) {
  ok(res, await service.get(req, busId(req)));
}
export async function create(req: Request, res: Response) {
  created(res, await service.create(req, validated<s.CreateBusBody>(req, 'body')));
}
export async function update(req: Request, res: Response) {
  ok(res, await service.update(req, busId(req), validated<s.UpdateBusBody>(req, 'body')));
}
export async function changeStatus(req: Request, res: Response) {
  ok(res, await service.changeStatus(req, busId(req), validated<s.BusStatusBody>(req, 'body')));
}
export async function remove(req: Request, res: Response) {
  ok(res, await service.remove(req, busId(req)));
}

// ── images ───────────────────────────────────────────────────────────────────
export async function listImages(req: Request, res: Response) {
  ok(res, await images.list(req, busId(req)));
}
export async function addImage(req: Request, res: Response) {
  created(res, await images.add(req, busId(req), validated<s.AddBusImageBody>(req, 'body')));
}
export async function updateImage(req: Request, res: Response) {
  const p = validated<s.BusImageParams>(req, 'params');
  ok(res, await images.update(req, p.id, p.imageId, validated<s.UpdateBusImageBody>(req, 'body')));
}
export async function reorderImages(req: Request, res: Response) {
  ok(res, await images.reorder(req, busId(req), validated<s.ReorderBusImagesBody>(req, 'body')));
}
export async function removeImage(req: Request, res: Response) {
  const p = validated<s.BusImageParams>(req, 'params');
  ok(res, await images.remove(req, p.id, p.imageId));
}

// ── staff assignment ─────────────────────────────────────────────────────────
export async function assignStaff(req: Request, res: Response) {
  ok(res, await assignments.assign(req, busId(req), validated<s.AssignStaffBody>(req, 'body')));
}
export const assignmentHistory = (req: Request, res: Response) =>
  assignments.history(req, res, busId(req), validated<s.AssignmentHistoryQuery>(req, 'query'));

// ── documents ────────────────────────────────────────────────────────────────
export async function listDocuments(req: Request, res: Response) {
  ok(res, await documents.list(req, busId(req), validated<s.BusDocumentsQuery>(req, 'query')));
}
export async function createDocument(req: Request, res: Response) {
  created(res, await documents.create(req, busId(req), validated<s.CreateBusDocumentBody>(req, 'body')));
}
export async function getDocument(req: Request, res: Response) {
  ok(res, await documents.get(req, docId(req)));
}
export async function replaceDocument(req: Request, res: Response) {
  created(res, await documents.replace(req, docId(req), validated<s.ReplaceBusDocumentBody>(req, 'body')));
}
export async function updateDocument(req: Request, res: Response) {
  ok(res, await documents.update(req, docId(req), validated<s.UpdateBusDocumentBody>(req, 'body')));
}
export async function setDocumentVisibility(req: Request, res: Response) {
  ok(res, await documents.setVisibility(req, docId(req), validated<s.BusDocumentVisibilityBody>(req, 'body')));
}
export async function verifyDocument(req: Request, res: Response) {
  ok(res, await documents.verify(req, docId(req), validated<s.VerifyBusDocumentBody>(req, 'body')));
}
export async function removeDocument(req: Request, res: Response) {
  ok(res, await documents.remove(req, docId(req)));
}
