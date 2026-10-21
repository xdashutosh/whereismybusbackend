// GET /parent/children (BP §4.6, §8.5, §15.2 home): every linked child grouped by school, with the
// school's branding, the child's class, and per direction the bus code, route, stop, next pickup/drop
// time and the BP §9.4 status of today's trip. Spans schools: the schools come from
// parent_children_index(); each school is then read in the parent's own tenant context (RLS +
// parent_scope), one query for the children plus the cached tracking configuration and the kv live
// state of running trips. Schools that are suspended, deleted or outside their plan are left out
// (every per-child call would be refused for them anyway).
import type { ParentChildCard, ParentChildrenResponse, ParentSchoolGroup, TripLiveState } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { unauthenticated } from '../../shared/errors.js';
import { optionalSignedUrl } from '../files/urls.js';
import { getLiveState, trackingConfig, type TrackingConfig } from '../tracking/index.js';
import * as repo from './repository.js';
import { markSchoolUsed, parentLinks, usableSchool, withParentSchool } from './schools.js';
import { directionCard, isAssigned } from './view.js';

interface SchoolSnapshot {
  brand: repo.SchoolBrandRow;
  rows: repo.ChildRow[];
  lives: Map<string, TripLiveState>;
  cfg: TrackingConfig;
}

async function readSchool(tx: Tx): Promise<SchoolSnapshot | null> {
  const brand = await repo.schoolBrand(tx);
  if (!brand) return null;
  const rows = await repo.childRows(tx);
  const cfg = await trackingConfig(tx);
  const running = [...new Set(rows.filter((r) => r.trip_status === 'in_progress' && r.trip_id).map((r) => r.trip_id!))];
  const lives = new Map<string, TripLiveState>();
  for (const tripId of running) {
    const live = await getLiveState(tx, tripId);
    if (live) lives.set(tripId, live);
  }
  return { brand, rows, lives, cfg };
}

async function toGroup(req: Request, s: SchoolSnapshot, nowMs: number): Promise<ParentSchoolGroup> {
  const cards = new Map<string, ParentChildCard & { photoKey: string | null }>();
  for (const r of s.rows) {
    let card = cards.get(r.student_id);
    if (!card) {
      card = { studentId: r.student_id, fullName: r.full_name, className: r.class_name, section: r.section, photoUrl: null, photoKey: r.photo_key, directions: [] };
      cards.set(r.student_id, card);
    }
    if (isAssigned(r)) card.directions.push(directionCard(r, r.trip_id ? (s.lives.get(r.trip_id) ?? null) : null, s.cfg, nowMs));
  }
  const children: ParentChildCard[] = [];
  for (const { photoKey, ...card } of cards.values()) {
    card.directions.sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'morning' ? -1 : 1));
    children.push({ ...card, photoUrl: await optionalSignedUrl(req, photoKey) });
  }
  return {
    schoolId: s.brand.id,
    schoolName: s.brand.name,
    institutionType: s.brand.institution_type,
    logoUrl: await optionalSignedUrl(req, s.brand.logo_key),
    brandColor: s.brand.brand_color,
    timezone: s.brand.timezone,
    children,
  };
}

export async function listChildren(req: Request): Promise<ParentChildrenResponse> {
  const parentId = req.auth?.actorId;
  if (!parentId) throw unauthenticated();
  const nowMs = Date.now();
  const schoolIds = [...new Set((await parentLinks(parentId)).map((l) => l.schoolId))];
  const groups: ParentSchoolGroup[] = [];
  for (const schoolId of schoolIds) {
    const school = await usableSchool(schoolId);
    if (!school) continue;
    const snapshot = await withParentSchool(parentId, school, readSchool);
    if (snapshot && snapshot.rows.length) {
      groups.push(await toGroup(req, snapshot, nowMs));
      await markSchoolUsed(parentId, school);
    }
  }
  groups.sort((a, b) => a.schoolName.localeCompare(b.schoolName) || a.schoolId.localeCompare(b.schoolId));
  return { generatedAt: new Date(nowMs).toISOString(), schools: groups };
}
