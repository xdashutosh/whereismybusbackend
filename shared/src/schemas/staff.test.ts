import { describe, expect, it } from 'vitest';
import { FULL_ID_MESSAGE, idProofLast4, looksLikeFullIdNumber, maskIdProof } from './staff.js';

describe('maskIdProof()', () => {
  it('masks per identity type', () => {
    expect(maskIdProof('aadhaar', '1234')).toBe('XXXX XXXX 1234');
    expect(maskIdProof('pan', '234F')).toBe('XXXXXX234F');
    expect(maskIdProof('passport', '9876')).toBe('••••9876');
    expect(maskIdProof(null, '9876')).toBe('••••9876');
  });
  it('returns null without the last 4 characters', () => {
    expect(maskIdProof('aadhaar', null)).toBeNull();
    expect(maskIdProof('aadhaar', '')).toBeNull();
  });
});

describe('looksLikeFullIdNumber()', () => {
  it('detects full Aadhaar numbers with or without separators', () => {
    for (const v of ['234567890123', '2345 6789 0123', '2345-6789-0123', ' 2345 6789 0123 ']) expect(looksLikeFullIdNumber(v), v).toBe(true);
  });
  it('detects full PAN numbers in any case', () => {
    expect(looksLikeFullIdNumber('ABCDE1234F')).toBe(true);
    expect(looksLikeFullIdNumber('abcde1234f')).toBe(true);
  });
  it('ignores partial numbers and Aadhaar numbers starting with 0 or 1', () => {
    for (const v of ['1234', '134567890123', '034567890123', 'ABCD1234F', 'DL-0420110012345']) expect(looksLikeFullIdNumber(v), v).toBe(false);
  });
});

describe('idProofLast4()', () => {
  it('upper-cases exactly four letters or digits', () => {
    expect(idProofLast4().parse(' 34f1 ')).toBe('34F1');
  });
  it('maps blank to null and keeps undefined', () => {
    expect(idProofLast4().parse('')).toBeNull();
    expect(idProofLast4().parse(undefined)).toBeUndefined();
  });
  it('refuses a full Aadhaar/PAN number with the privacy message', () => {
    const r = idProofLast4().safeParse('2345 6789 0123');
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message)).toContain(FULL_ID_MESSAGE);
  });
  it('refuses anything that is not exactly four characters', () => {
    for (const v of ['123', '12345', '12 4']) expect(idProofLast4().safeParse(v).success, v).toBe(false);
  });
});
