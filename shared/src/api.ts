// API envelope types (contract §5). Success: { success: true, data, meta? }; error:
// { success: false, error: { code, message, details?, requestId } }.
import type { ErrorCode } from './enums.js';

export const API_PREFIX = '/api/v1';

export interface ListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
}

export interface ListEnvelope<T> {
  success: true;
  data: T[];
  meta: ListMeta;
}

export interface FieldIssue {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId: string;
}

export interface ErrorEnvelope {
  success: false;
  error: ApiErrorBody;
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;
export type ApiListEnvelope<T> = ListEnvelope<T> | ErrorEnvelope;

/** Payload of the compact live-position socket event / tracking snapshot (BP §9.1 keys). */
export interface LivePosition {
  tripId: string;
  t: string;
  lat: number;
  lng: number;
  spd?: number | null;
  hdg?: number | null;
  acc?: number | null;
  mv?: boolean | null;
}
