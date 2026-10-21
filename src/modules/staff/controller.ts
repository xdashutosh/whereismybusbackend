// HTTP layer of the staff module: read req.valid, call the service, send the envelope.
import type { Request, Response } from 'express';
import { created, ok } from '../../shared/envelope.js';
import { validated } from '../../shared/validate.js';
import { revokeSessions as revokeStaffSessions, setCredentials } from './credentials.js';
import * as documents from './documentsService.js';
import * as extra from './historyAndPreview.js';
import type * as s from './schemas.js';
import * as service from './service.js';

const staffId = (req: Request) => validated<s.StaffParams>(req, 'params').id;
const docId = (req: Request) => validated<s.StaffDocumentParams>(req, 'params').docId;

// ── profiles ─────────────────────────────────────────────────────────────────
export const list = (req: Request, res: Response) => service.list(req, res, validated<s.StaffListQuery>(req, 'query'));
export async function get(req: Request, res: Response) {
  ok(res, await service.get(req, staffId(req)));
}
export async function create(req: Request, res: Response) {
  created(res, await service.create(req, validated<s.CreateStaffBody>(req, 'body')));
}
export async function update(req: Request, res: Response) {
  ok(res, await service.update(req, staffId(req), validated<s.UpdateStaffBody>(req, 'body')));
}
export async function remove(req: Request, res: Response) {
  ok(res, await service.remove(req, staffId(req)));
}
export async function activate(req: Request, res: Response) {
  ok(res, await service.activate(req, staffId(req)));
}
export async function deactivate(req: Request, res: Response) {
  ok(res, await service.deactivate(req, staffId(req), validated<s.DeactivateBody>(req, 'body')));
}
export async function credentials(req: Request, res: Response) {
  res.setHeader('Cache-Control', 'no-store');
  const result = await setCredentials(req, staffId(req), validated<s.CredentialsBody>(req, 'body'));
  if (result.created) created(res, result);
  else ok(res, result);
}

// ── history and parent preview ───────────────────────────────────────────────
export const assignmentHistory = (req: Request, res: Response) => extra.history(req, res, staffId(req), validated<s.StaffAssignmentHistoryQuery>(req, 'query'));
export async function parentPreview(req: Request, res: Response) {
  ok(res, await extra.parentPreview(req, staffId(req)));
}

// ── documents ────────────────────────────────────────────────────────────────
export async function listDocuments(req: Request, res: Response) {
  ok(res, await documents.list(req, staffId(req), validated<s.StaffDocumentsQuery>(req, 'query')));
}
export async function createDocument(req: Request, res: Response) {
  created(res, await documents.create(req, staffId(req), validated<s.CreateStaffDocumentBody>(req, 'body')));
}
export async function getDocument(req: Request, res: Response) {
  ok(res, await documents.get(req, docId(req)));
}
export async function replaceDocument(req: Request, res: Response) {
  created(res, await documents.replace(req, docId(req), validated<s.ReplaceStaffDocumentBody>(req, 'body')));
}
export async function updateDocument(req: Request, res: Response) {
  ok(res, await documents.update(req, docId(req), validated<s.UpdateStaffDocumentBody>(req, 'body')));
}
export async function setDocumentVisibility(req: Request, res: Response) {
  ok(res, await documents.setVisibility(req, docId(req), validated<s.StaffDocumentVisibilityBody>(req, 'body')));
}
export async function verifyDocument(req: Request, res: Response) {
  ok(res, await documents.verify(req, docId(req), validated<s.VerifyStaffDocumentBody>(req, 'body')));
}
export async function removeDocument(req: Request, res: Response) {
  ok(res, await documents.remove(req, docId(req)));
}
export async function revokeSessions(req: Request, res: Response) {
  ok(res, await revokeStaffSessions(req, staffId(req)));
}
