// Public legal links and school branding (BP §13.1 school sign-in branding, §16 "Privacy policy URL
// per app"). Both answers are public information and cached per process for LEGAL_CACHE_TTL_MS
// (dropped early when a school's status/profile/settings or a platform setting changes); responses
// carry Cache-Control: public, max-age=60. The logo URL is signed per request (short-lived), so a
// cached lookup never hands out an expired link.
import type { PublicLegalDto, SchoolBrandingDto } from '@wimb/shared';
import type { Request } from 'express';
import { LRUCache } from 'lru-cache';
import { notFound } from '../../shared/errors.js';
import { events } from '../../shared/events.js';
import { optionalSignedUrl } from '../files/urls.js';
import * as repo from './repository.js';

export const LEGAL_CACHE_TTL_MS = 60_000;
export const PUBLIC_CACHE_CONTROL = 'public, max-age=60';

const brandingCache = new LRUCache<string, { row: repo.BrandingRow | null }>({ max: 2000, ttl: LEGAL_CACHE_TTL_MS });
let platformCache: { at: number; value: PublicLegalDto } | null = null;

/** Drops every cached answer (events below; tests). */
export function clearLegalCaches(): void {
  brandingCache.clear();
  platformCache = null;
}
events.on('school.status_changed', clearLegalCaches);
events.on('school.profile_changed', clearLegalCaches);
events.on('school.settings_changed', clearLegalCaches);
events.on('platform_settings.changed', ({ key }) => {
  if (key.startsWith('legal.')) clearLegalCaches();
});

export const toLegalDto = (r: repo.LegalRow): PublicLegalDto => ({ privacyUrl: r.privacy_url, termsUrl: r.terms_url, consentVersion: r.consent_version });

/** GET /auth/legal — the platform's privacy policy / terms links and consent version. */
export async function platformLegal(): Promise<PublicLegalDto> {
  if (platformCache && Date.now() - platformCache.at < LEGAL_CACHE_TTL_MS) return platformCache.value;
  const value = toLegalDto(await repo.legalTerms(null));
  platformCache = { at: Date.now(), value };
  return value;
}

/** GET /auth/school/branding?code= — active schools only; 404 for unknown, inactive or deleted codes. */
export async function schoolBranding(req: Request, code: string): Promise<SchoolBrandingDto> {
  let hit = brandingCache.get(code);
  if (!hit) {
    hit = { row: await repo.brandingByCode(code) };
    brandingCache.set(code, hit);
  }
  const r = hit.row;
  if (!r) throw notFound('School not found.');
  return {
    name: r.name,
    code: r.code,
    logoUrl: await optionalSignedUrl(req, r.logo_key),
    brandColor: r.brand_color,
    institutionType: r.institution_type,
    privacyUrl: r.privacy_url,
    termsUrl: r.terms_url,
  };
}
