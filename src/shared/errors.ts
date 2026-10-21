// Application errors (contract §5). Every error the API returns is an AppError with a stable code;
// the central errorHandler renders { success:false, error:{ code, message, details, requestId } }.
import { ERROR_CODES, ERROR_STATUS, type ErrorCode, type FieldIssue } from '@wimb/shared';

export { ERROR_CODES, ERROR_STATUS, type ErrorCode };

/** Default human-readable message per code. */
export const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = Object.freeze({
  VALIDATION_ERROR: 'The request is invalid.',
  UNAUTHENTICATED: 'Authentication is required.',
  TOKEN_EXPIRED: 'The access token has expired.',
  TOTP_REQUIRED: 'A two-factor authentication code is required.',
  PASSWORD_CHANGE_REQUIRED: 'You must change your password before continuing.',
  FORBIDDEN: 'You are not allowed to perform this action.',
  SCHOOL_INACTIVE: 'This school account is not active.',
  DEVICE_NOT_BOUND: 'This device is not registered for the current session.',
  APP_UPDATE_REQUIRED: 'This app version is no longer supported. Please update the app.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with the current state of the resource.',
  DUPLICATE: 'A record with the same identifier already exists.',
  INVALID_STATE: 'This action is not allowed in the current state.',
  TRIP_ALREADY_ACTIVE: 'A trip is already in progress for this bus or user.',
  ODOMETER_INVALID: 'The odometer reading is invalid.',
  PAYLOAD_TOO_LARGE: 'The request payload is too large.',
  UNSUPPORTED_FILE: 'The uploaded file type is not supported.',
  RATE_LIMITED: 'Too many requests. Please try again later.',
  INTERNAL_ERROR: 'An unexpected error occurred.',
  SERVICE_UNAVAILABLE: 'The service is temporarily unavailable.',
});

export interface AppErrorOptions {
  details?: unknown;
  status?: number;
  headers?: Record<string, string>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: unknown;
  readonly headers: Record<string, string> | undefined;
  readonly isAppError = true as const;

  constructor(code: ErrorCode, message?: string, { details, status, headers, cause }: AppErrorOptions = {}) {
    if (!(code in ERROR_STATUS)) throw new TypeError(`Unknown error code: ${String(code)}`);
    super(message ?? DEFAULT_MESSAGES[code], cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? ERROR_STATUS[code];
    this.details = details;
    this.headers = headers;
  }

  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) };
  }
}

export function isAppError(err: unknown): err is AppError {
  return Boolean(err && typeof err === 'object' && (err as { isAppError?: unknown }).isAppError === true);
}

type Factory = (message?: string, details?: unknown, opts?: Omit<AppErrorOptions, 'details'>) => AppError;
const make =
  (code: ErrorCode): Factory =>
  (message, details, opts = {}) =>
    new AppError(code, message, { ...opts, details });

export const validationError = make('VALIDATION_ERROR');
export const unauthenticated = make('UNAUTHENTICATED');
export const tokenExpired = make('TOKEN_EXPIRED');
export const totpRequired = make('TOTP_REQUIRED');
export const passwordChangeRequired = make('PASSWORD_CHANGE_REQUIRED');
export const forbidden = make('FORBIDDEN');
export const schoolInactive = make('SCHOOL_INACTIVE');
export const deviceNotBound = make('DEVICE_NOT_BOUND');
export const appUpdateRequired = make('APP_UPDATE_REQUIRED');
export const notFound = make('NOT_FOUND');
export const conflict = make('CONFLICT');
export const duplicate = make('DUPLICATE');
export const invalidState = make('INVALID_STATE');
export const tripAlreadyActive = make('TRIP_ALREADY_ACTIVE');
export const odometerInvalid = make('ODOMETER_INVALID');
export const payloadTooLarge = make('PAYLOAD_TOO_LARGE');
export const unsupportedFile = make('UNSUPPORTED_FILE');
export const internalError = make('INTERNAL_ERROR');
export const serviceUnavailable = make('SERVICE_UNAVAILABLE');

/** 429 with a Retry-After header (seconds, rounded up, at least 1). */
export function rateLimited(retryAfterSeconds: number, message?: string, details?: unknown): AppError {
  const secs = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 1));
  return new AppError('RATE_LIMITED', message, { details: details ?? { retryAfterSeconds: secs }, headers: { 'Retry-After': String(secs) } });
}

/** Single-field validation error: fieldError('stops[2].stopId', 'Stop is inactive'). */
export function fieldError(path: string, message: string): AppError {
  const details: FieldIssue[] = [{ path, message }];
  return validationError(message, details);
}

/** Throws NOT_FOUND when value is null/undefined, otherwise returns it (also for cross-tenant ids). */
export function assertFound<T>(value: T | null | undefined, message?: string): T {
  if (value === null || value === undefined) throw notFound(message);
  return value;
}

export const errors = {
  AppError,
  isAppError,
  validationError,
  unauthenticated,
  tokenExpired,
  totpRequired,
  passwordChangeRequired,
  forbidden,
  schoolInactive,
  deviceNotBound,
  appUpdateRequired,
  notFound,
  conflict,
  duplicate,
  invalidState,
  tripAlreadyActive,
  odometerInvalid,
  payloadTooLarge,
  unsupportedFile,
  rateLimited,
  internalError,
  serviceUnavailable,
  fieldError,
  assertFound,
};
export default errors;
