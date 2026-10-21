// Storage facade with the local driver (tests never touch S3): prefix enforcement, BP §12 school
// keys, put/head/stream/delete, signed local upload/download tokens, TTL clamping.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import config, { ROOT_DIR } from '../src/config/index.js';
import { clampTtl, contentDisposition, createStorage, sanitizeFileName, signLocalToken, verifyLocalToken, type Storage } from '../src/shared/storage.js';

const SCHOOL = '5c000000-0000-4000-8000-000000000001';
const ENTITY = 'e0000000-0000-4000-8000-000000000001';
let dir: string;
let storage: Storage;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wimb-storage-'));
  storage = createStorage({ ...config.storage, driver: 'local', localDir: dir, keyPrefix: 'whereismybus-test/' });
});
afterAll(async () => {
  await storage.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('test run storage root', () => {
  it('stores test uploads in the run-private temp folder, never under backend/storage', async () => {
    const root = inject('storageDir');
    expect(config.storage.localDir).toBe(root);
    expect(path.relative(os.tmpdir(), root).startsWith('..')).toBe(false);
    expect(path.relative(path.join(ROOT_DIR, 'storage'), root).startsWith('..')).toBe(true);
    expect((await fs.stat(root)).isDirectory()).toBe(true);
  });
});

describe('keys', () => {
  it('builds BP §12 school keys under the prefix and reads the school back', () => {
    const key = storage.schoolObjectKey({ schoolId: SCHOOL.toUpperCase(), category: 'bus_document', entityId: ENTITY, extension: 'pdf' });
    expect(key).toMatch(new RegExp(`^whereismybus-test/schools/${SCHOOL}/bus_document/${ENTITY}/[0-9a-f-]{36}\\.pdf$`));
    expect(storage.schoolIdOfKey(key)).toBe(SCHOOL);
    expect(storage.schoolIdOfKey('whereismybus-test/platform/x')).toBeNull();
    expect(() => storage.schoolObjectKey({ schoolId: 'x', category: 'bus_image', entityId: ENTITY, extension: 'jpg' })).toThrow(TypeError);
    expect(() => storage.schoolObjectKey({ schoolId: SCHOOL, category: 'bus_image', entityId: ENTITY, extension: 'j/pg' })).toThrow(TypeError);
  });

  it('refuses keys outside the prefix or with traversal', async () => {
    await expect(storage.headObject('other/thing')).rejects.toThrow(/outside the configured prefix/);
    await expect(storage.headObject('whereismybus-test/../etc/passwd')).rejects.toThrow(TypeError);
    expect(() => storage.keyFor('a', '..', 'b')).toThrow(TypeError);
    expect(storage.keyFor('/platform/', 'exports', 'x.csv')).toBe('whereismybus-test/platform/exports/x.csv');
  });
});

describe('local driver', () => {
  it('puts, heads, streams and deletes objects', async () => {
    const key = storage.keyFor('platform', 'probe.txt');
    await storage.putObject({ key, body: Buffer.from('hello'), contentType: 'text/plain', checksum: 'abc' });
    expect(await storage.headObject(key)).toMatchObject({ key, size: 5, contentType: 'text/plain', checksum: 'abc' });
    const obj = await storage.getObjectStream(key);
    expect(await text(obj!.stream)).toBe('hello');
    await storage.deleteObject(key);
    expect(await storage.headObject(key)).toBeNull();
    expect(await storage.getObjectStream(key)).toBeNull();
    expect(await storage.deleteObjectQuietly('bad/key')).toBe(false);
    await expect(storage.putObject({ key, body: 'x' as unknown as Buffer, contentType: 'text/plain' })).rejects.toThrow(/Buffer/);
  });

  it('issues signed, expiring local download and upload URLs', async () => {
    const key = storage.keyFor('platform', 'f.pdf');
    const down = await storage.getDownloadUrl(key, { localPath: '/api/v1/files/local', fileName: 'Report.pdf', expiresInSec: 90 });
    const token = new URL(down.url, 'http://x').searchParams.get('token');
    expect(verifyLocalToken(token, 'download')).toEqual({ key, fileName: 'Report.pdf', contentType: null, maxBytes: null });
    expect(verifyLocalToken(token, 'upload')).toBeNull(); // purpose-bound
    expect(verifyLocalToken(`${token!.slice(0, -2)}xx`, 'download')).toBeNull(); // tampered
    expect(verifyLocalToken(token, 'download', { now: Date.now() + 91_000 })).toBeNull(); // expired
    const up = await storage.getUploadUrl(key, { contentType: 'application/pdf', contentLength: 1234, localPath: '/api/v1/files/local-upload' });
    expect(up).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'application/pdf' } });
    expect(verifyLocalToken(new URL(up.url, 'http://x').searchParams.get('token'), 'upload')).toMatchObject({ key, contentType: 'application/pdf', maxBytes: 1234 });
    await expect(storage.getDownloadUrl(key)).rejects.toThrow(/localPath/);
    expect(verifyLocalToken(signLocalToken('download', { k: key, e: 1 }), 'download')).toBeNull();
  });

  it('reports health without secrets', async () => {
    expect(await storage.healthCheck()).toMatchObject({ ok: true, driver: 'local' });
  });
});

describe('helpers', () => {
  it('clamps URL lifetimes to 60–300 s', () => {
    expect(clampTtl(5)).toBe(60);
    expect(clampTtl(10_000)).toBe(300);
    expect(clampTtl(undefined)).toBe(120);
    expect(clampTtl(Number.NaN)).toBe(120);
  });

  it('sanitises file names and builds safe Content-Disposition values', () => {
    expect(sanitizeFileName('../../etc/pässwd .pdf')).toBe('passwd_.pdf');
    expect(sanitizeFileName('')).toBe('file');
    expect(contentDisposition('Fuel report – Oct.csv')).toBe(`attachment; filename="Fuel_report_Oct.csv"; filename*=UTF-8''${encodeURIComponent('Fuel report – Oct.csv')}`);
  });
});
