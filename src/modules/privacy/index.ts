// Public surface of the privacy module for other modules (auth profile: consent flag, legal links).
export { parentConsentStatus, schoolConsentState, type SchoolConsentState } from './consent.js';
export { clearLegalCaches, platformLegal } from './legal.js';
