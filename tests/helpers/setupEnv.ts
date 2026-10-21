// vitest setupFiles: runs in every test worker before the test file is imported.
import { inject } from 'vitest';
import { applyTestEnv } from './testEnv.js';

// The run-private storage root from globalSetup (provideTestStorage) — never backend/storage.
const storageDir = inject('storageDir');
if (!storageDir) throw new Error('storageDir was not provided: run tests through a vitest config whose globalSetup calls provideTestStorage()');
applyTestEnv(storageDir);
