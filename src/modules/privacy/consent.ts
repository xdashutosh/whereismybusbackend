// Parent consent (BP §16 "parental consent flow", DPDP Act s.9; docs/api/privacy.md). Each school is
// the data fiduciary for its own children, so consent is recorded per school: the version the parent
// accepted, when, the links in force and the app that recorded it (parent_consents, migration 901).
// The required version is the school's override or the platform's legal.consent_version; a change of
// that version makes consentRequired true again for every parent of the school (re-consent). The API
// does not block other parent calls without consent — the parent app shows the consent screen
// whenever consentRequired is true (sign-in response, GET /auth/me, GET /parent/consent).
import type { ParentConsentBody, ParentConsentStatusDto, ParentSchoolConsentDto } from '@wimb/shared';
import type { Request } from 'express';
import { withTenant, type Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { conflict, unauthenticated } from '../../shared/errors.js';
import { clientInfo } from '../auth/controller.js';
import { parentChildren } from '../auth/repository.js';
import * as repo from './repository.js';

export interface SchoolConsentState {
  requiredVersion: string;
  acceptedVersion: string | null;
  acceptedAt: string | null;
  consentRequired: boolean;
  privacyUrl: string | null;
  termsUrl: string | null;
}

/** Consent state of a parent in the transaction's school (parent or school-admin context). */
export async function schoolConsentState(tx: Tx, parentAccountId: string, schoolId: string): Promise<SchoolConsentState> {
  const terms = await repo.legalTermsTx(tx, schoolId);
  const latest = await repo.currentConsent(tx, parentAccountId, terms.consent_version);
  return {
    requiredVersion: terms.consent_version,
    acceptedVersion: latest?.version ?? null,
    acceptedAt: latest?.accepted_at ?? null,
    consentRequired: latest?.version !== terms.consent_version,
    privacyUrl: terms.privacy_url,
    termsUrl: terms.terms_url,
  };
}

/** Consent per school for every school where the parent has an active child link. */
export async function parentConsentStatus(parentAccountId: string): Promise<ParentConsentStatusDto> {
  const schoolIds = [...new Set((await parentChildren(parentAccountId)).map((l) => l.school_id))];
  const schools = await Promise.all(
    schoolIds.map((schoolId) =>
      withTenant(
        { schoolId, actorId: parentAccountId, role: 'parent' },
        async (tx): Promise<ParentSchoolConsentDto | null> => {
          const school = await repo.schoolOfContext(tx, schoolId);
          if (!school || school.status !== 'active' || school.deleted_at) return null;
          return { schoolId, schoolName: school.name, ...(await schoolConsentState(tx, parentAccountId, schoolId)) };
        },
        { readOnly: true },
      ),
    ),
  );
  const list = schools.filter((s): s is ParentSchoolConsentDto => s !== null).sort((a, b) => a.schoolName.localeCompare(b.schoolName));
  return { consentRequired: list.some((s) => s.consentRequired), schools: list };
}

/** GET /parent/consent */
export function getConsent(req: Request): Promise<ParentConsentStatusDto> {
  if (!req.auth) throw unauthenticated();
  return parentConsentStatus(req.auth.actorId);
}

/**
 * POST /parent/consent (X-School-Id) — records the parent's acceptance of the school's CURRENT consent
 * version (409 CONFLICT with details.requiredVersion when the app showed an older text). Idempotent;
 * audited in the school's log (`privacy.consent_accept`).
 */
export async function acceptConsent(req: Request, body: ParentConsentBody): Promise<ParentSchoolConsentDto> {
  const auth = req.auth;
  if (!auth || !req.tenant) throw unauthenticated();
  const schoolId = req.tenant.schoolId;
  const client = clientInfo(req);
  return withRequestTenant(req, async (tx) => {
    const terms = await repo.legalTermsTx(tx, schoolId);
    if (body.version !== terms.consent_version) {
      throw conflict('The consent text has changed. Please review it again.', { reason: 'CONSENT_VERSION_CHANGED', requiredVersion: terms.consent_version });
    }
    const before = await repo.currentConsent(tx, auth.actorId, terms.consent_version);
    const row = await repo.acceptConsent(tx, { version: body.version, appName: client.appName, appVersion: client.appVersion, ip: client.ip, userAgent: client.userAgent });
    if (before?.version !== row.version) {
      await audit.log(tx, { action: 'privacy.consent_accept', entityType: 'parent_consent', entityId: row.id, new: { version: row.version, appName: client.appName, appVersion: client.appVersion } });
    }
    const school = await repo.schoolOfContext(tx, schoolId);
    return { schoolId, schoolName: school?.name ?? '', ...(await schoolConsentState(tx, auth.actorId, schoolId)) };
  });
}
