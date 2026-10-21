// Public surface of the school module for other modules (trips, tracking, alerts, notifications,
// buses, staff, parent, driver). Every helper runs inside the caller's transaction (`tx` from
// withTenant / withRequestTenant / withSchoolSystem) and reads the CURRENT school through RLS.
//   loadSchoolSettings(tx)       full settings DTO (thresholds, effective intervals and features)
//   loadParentVisibility(tx)     complete camelCase visibility matrix (BP defaults for gaps)
//   isFeatureEnabled(tx, key)    feature flag in force (school flag narrowed by the platform)
//   holidaysOn(tx, date, dir)    holidays covering a school-local date for a direction
//   isSchoolHoliday(tx, …)       boolean shortcut (trip generation, "not started" checks)
//   visibleAnnouncements(tx, a)  published announcements for 'drivers' | 'parents'
// Events (after commit): 'announcement.published', 'announcement.changed',
// 'school.settings_changed', 'school.profile_changed' (see ./events.ts).
import type { AnnouncementDto, HolidayDto, ParentVisibility, SchoolFeatureKey, SchoolSettingsDto } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { assertFound } from '../../shared/errors.js';
import * as announcementRepo from './announcementRepository.js';
import { toDto as announcementDto } from './announcements.js';
import * as holidayRepo from './holidayRepository.js';
import { toDto as holidayDto } from './holidays.js';
import * as repo from './repository.js';
import { PLATFORM_KEYS, readParentVisibility, settingsDto } from './settingsModel.js';
import './events.js';

export type { AnnouncementEventPayload } from './events.js';

export async function loadSchoolSettings(tx: Tx): Promise<SchoolSettingsDto> {
  return settingsDto(assertFound(await repo.getSettings(tx, PLATFORM_KEYS), 'The school settings were not found.'));
}

export async function loadParentVisibility(tx: Tx): Promise<ParentVisibility> {
  const row = assertFound(await repo.getSettings(tx, []), 'The school settings were not found.');
  return readParentVisibility(row.parent_visibility);
}

export async function isFeatureEnabled(tx: Tx, key: SchoolFeatureKey): Promise<boolean> {
  return (await loadSchoolSettings(tx)).effective.features[key];
}

export async function holidaysOn(tx: Tx, localDate: string, direction: 'morning' | 'afternoon' | null = null): Promise<HolidayDto[]> {
  return (await holidayRepo.coveringHolidays(tx, localDate, direction)).map(holidayDto);
}

export async function isSchoolHoliday(tx: Tx, localDate: string, direction: 'morning' | 'afternoon' | null = null): Promise<boolean> {
  return (await holidayRepo.coveringHolidays(tx, localDate, direction)).length > 0;
}

export async function visibleAnnouncements(tx: Tx, audience: 'drivers' | 'parents', limit = 20): Promise<AnnouncementDto[]> {
  return (await announcementRepo.visibleFor(tx, audience, limit)).map(announcementDto);
}
