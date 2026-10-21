// Upload validation: magic-byte sniffing, per-kind allow-lists and limits, multer integration and
// sharp normalisation (EXIF/GPS stripping, orientation, thumbnails).
import express from 'express';
import sharp from 'sharp';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { requestId } from '../src/middleware/requestId.js';
import { inspectFile, processImage, sniffFileType, uploadSingle, UPLOAD_KINDS } from '../src/shared/uploads.js';

async function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 200, g: 30, b: 30 } } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'secret-owner' }, IFD3: { GPSLatitudeRef: 'N' } } })
    .toBuffer();
}

const png = () => sharp({ create: { width: 10, height: 10, channels: 4, background: '#0070F2' } }).png().toBuffer();
const webp = () => sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).webp().toBuffer();

describe('sniffFileType', () => {
  it('detects real types from content', async () => {
    expect(sniffFileType(await jpegWithExif())).toBe('jpeg');
    expect(sniffFileType(await png())).toBe('png');
    expect(sniffFileType(await webp())).toBe('webp');
    expect(sniffFileType(Buffer.from('%PDF-1.7\n...'))).toBe('pdf');
    expect(sniffFileType(Buffer.from('\uFEFFname,phone\nA,1\n'))).toBe('csv');
    expect(sniffFileType(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(8)]))).toBe('heic');
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....[Content_Types].xml....xl/workbook.xml')]);
    expect(sniffFileType(zip)).toBe('xlsx');
    expect(sniffFileType(Buffer.from('MZ\x90\x00 executable'))).toBeNull();
    expect(sniffFileType(Buffer.from('just text without separators'))).toBeNull();
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
  });
});

describe('inspectFile', () => {
  it('accepts allowed types, fixes the extension and hashes the content', async () => {
    const buffer = await png();
    const f = inspectFile({ buffer, originalname: 'photo.jpeg' }, 'PHOTO');
    expect(f).toMatchObject({ detectedType: 'png', contentType: 'image/png', extension: 'png', safeName: 'photo.png', size: buffer.length });
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects disallowed, empty and oversized files', () => {
    expect(() => inspectFile({ buffer: Buffer.from('%PDF-1.4'), originalname: 'x.pdf' }, 'PHOTO')).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_FILE' }));
    expect(() => inspectFile({ buffer: Buffer.alloc(0) }, 'DOCUMENT')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(UPLOAD_KINDS.IMPORT.maxBytes)]);
    expect(() => inspectFile({ buffer: big }, 'IMPORT')).toThrow(expect.objectContaining({ code: 'PAYLOAD_TOO_LARGE' }));
  });
});

describe('uploadSingle', () => {
  const app = express();
  app.use(requestId());
  app.post('/upload', uploadSingle('PHOTO'), (req, res) => {
    res.json({ type: req.upload?.detectedType, name: req.upload?.safeName, note: (req.body as { note?: string }).note });
  });
  app.post('/optional', uploadSingle('DOCUMENT', { required: false }), (req, res) => {
    res.json({ hasFile: Boolean(req.upload) });
  });
  app.use(errorHandler());

  it('parses one file plus text fields', async () => {
    const res = await request(app).post('/upload').field('note', 'front').attach('file', await png(), { filename: 'bus.png', contentType: 'application/octet-stream' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: 'png', name: 'bus.png', note: 'front' });
  });

  it('maps type, size, missing and unexpected-field errors to the envelope', async () => {
    const wrong = await request(app).post('/upload').attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'x.png', contentType: 'image/png' });
    expect(wrong.status).toBe(415);
    expect(wrong.body.error.code).toBe('UNSUPPORTED_FILE');
    const big = await request(app).post('/upload').attach('file', Buffer.alloc(UPLOAD_KINDS.PHOTO.maxBytes + 1, 1), 'big.png');
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    const missing = await request(app).post('/upload').field('note', 'x');
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].path).toBe('file');
    const other = await request(app).post('/upload').attach('photo', await png(), 'x.png');
    expect(other.status).toBe(400);
    expect((await request(app).post('/optional').field('a', 'b')).body).toEqual({ hasFile: false });
  });
});

describe('processImage', () => {
  it('strips EXIF/GPS, applies orientation and builds a thumbnail', async () => {
    const input = await jpegWithExif();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const out = await processImage(input, { thumbnailSize: 16 });
    const meta = await sharp(out.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect([out.width, out.height]).toEqual([32, 64]); // rotated by orientation 6
    expect(out.contentType).toBe('image/jpeg');
    expect(out.thumbnail).toMatchObject({ contentType: 'image/webp', extension: 'webp' });
    expect(Math.max(out.thumbnail!.width, out.thumbnail!.height)).toBe(16);
  });

  it('keeps metadata when asked (evidence) and rejects non-images', async () => {
    const kept = await processImage(await jpegWithExif(), { keepMetadata: true, thumbnailSize: null });
    expect((await sharp(kept.buffer).metadata()).exif).toBeDefined();
    expect(kept.thumbnail).toBeNull();
    await expect(processImage(Buffer.from('%PDF-1.4'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' });
  });
});
