#!/usr/bin/env node
// Verifies that the object-storage bucket is PRIVATE (BP §12: "Private bucket only. No public ACLs").
//   node scripts/check-s3-private.mjs        → exit 0 when private, 1 when anything is public
// Reads the S3 settings like the backend does (process env > .env.local > .env of this repo),
// but needs real S3 credentials (STORAGE_DRIVER is ignored). It writes ONE small probe object under
// <S3_KEY_PREFIX>_probe/, tries anonymous (unsigned) GET / LIST / PUT, reads the bucket ACL and
// policy, then deletes every probe object. Bucket name, keys and endpoints host are never printed.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BACKEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(BACKEND, 'package.json'));
const dotenv = require('dotenv');
for (const f of ['.env.local', '.env']) {
  const p = path.join(BACKEND, f);
  if (existsSync(p)) dotenv.config({ path: p, override: false, quiet: true });
}
const s3 = require('@aws-sdk/client-s3');

const env = process.env;
const need = ['AWS_BUCKET_NAME', 'AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'S3_ENDPOINT'];
const missing = need.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Missing S3 settings: ${missing.join(', ')}`);
  process.exit(2);
}
const SECRET_VALUES = ['AWS_BUCKET_NAME', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].map((k) => [k, env[k]]).filter(([, v]) => v && v.length >= 3);
const mask = (s) => SECRET_VALUES.reduce((out, [k, v]) => out.split(v).join(`<${k}>`), String(s));
const log = (...a) => console.log(mask(a.join(' ')));

let prefix = (env.S3_KEY_PREFIX ?? 'whereismybus/').trim().replace(/^\/+/, '');
if (prefix && !prefix.endsWith('/')) prefix += '/';
const Bucket = env.AWS_BUCKET_NAME;
const ep = new URL(env.S3_ENDPOINT);
const client = new s3.S3Client({
  region: env.AWS_REGION,
  endpoint: env.S3_ENDPOINT,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
const virtualHosted = (key) => `${ep.protocol}//${Bucket}.${ep.host}/${key}`;
const pathStyle = (key) => `${ep.protocol}//${ep.host}/${Bucket}/${key}`;
const denied = (status) => status === 401 || status === 403;
const sdkErr = (e) => `${e.name} ${e.$metadata?.httpStatusCode ?? ''}`.trim();

const problems = [];
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const readKey = `${prefix}_probe/${stamp}-privacy-read.txt`;
const writeKey = `${prefix}_probe/${stamp}-privacy-anon-put.txt`;
const body = `privacy-probe-${stamp}`;

try {
  await client.send(new s3.PutObjectCommand({ Bucket, Key: readKey, Body: body, ContentType: 'text/plain' }));

  for (const [label, url] of [['virtual-hosted', virtualHosted(readKey)], ['path-style', pathStyle(readKey)]]) {
    const r = await fetch(url);
    const leaked = (await r.text()) === body;
    log(`anonymous GET object (${label}): ${r.status}${leaked ? ' — returned the object body' : ''}`);
    if (!denied(r.status) || leaked) problems.push(`objects are anonymously readable (${label})`);
  }

  const list = await fetch(`${ep.protocol}//${Bucket}.${ep.host}/?list-type=2&max-keys=0&prefix=${encodeURIComponent(`${prefix}_probe/`)}`);
  log(`anonymous LIST bucket: ${list.status}`);
  if (!denied(list.status)) problems.push('the bucket is anonymously listable');

  const put = await fetch(virtualHosted(writeKey), { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: 'anonymous write probe' });
  const written = await client.send(new s3.HeadObjectCommand({ Bucket, Key: writeKey })).then(() => true, () => false);
  log(`anonymous PUT object: ${put.status}${written ? ' — object was created' : ''}`);
  if (!denied(put.status) || written) problems.push('the bucket is anonymously writable');

  const acl = await client.send(new s3.GetBucketAclCommand({ Bucket })).catch((e) => ({ error: sdkErr(e) }));
  if (acl.error) log(`bucket ACL: could not read (${acl.error})`);
  else {
    const open = (acl.Grants ?? []).filter((g) => /AllUsers|AuthenticatedUsers/.test(g.Grantee?.URI ?? ''));
    log(`bucket ACL public grants: ${open.length ? open.map((g) => `${g.Grantee.URI.split('/').pop()} ${g.Permission}`).join(', ') : 'none'}`);
    if (open.length) problems.push('the bucket ACL grants AllUsers/AuthenticatedUsers access (set it to Private)');
  }

  const pol = await client.send(new s3.GetBucketPolicyCommand({ Bucket })).catch((e) => ({ error: e }));
  if (pol.error) {
    const none = pol.error.name === 'NoSuchBucketPolicy' || pol.error.$metadata?.httpStatusCode === 404;
    log(`bucket policy: ${none ? 'none' : `could not read (${sdkErr(pol.error)})`}`);
  } else {
    const statements = [].concat(JSON.parse(pol.Policy ?? '{}').Statement ?? []);
    const pub = statements.filter((st) => st.Effect === 'Allow' && (st.Principal === '*' || st.Principal?.AWS === '*' || [].concat(st.Principal?.AWS ?? []).includes('*')));
    log(`bucket policy public Allow statements: ${pub.length ? pub.map((st) => st.Sid ?? '(no Sid)').join(', ') : 'none'}`);
    if (pub.length) problems.push('the bucket policy allows Principal "*" (delete the policy)');
  }
} catch (e) {
  log(`ERROR ${sdkErr(e)} ${String(e.message ?? '').slice(0, 160)}`);
  problems.push('the check could not complete');
} finally {
  for (const Key of [readKey, writeKey]) await client.send(new s3.DeleteObjectCommand({ Bucket, Key })).catch(() => {});
  const left = await Promise.all([readKey, writeKey].map((Key) => client.send(new s3.HeadObjectCommand({ Bucket, Key })).then(() => Key, () => null)));
  log(`probe cleanup: ${left.some(Boolean) ? 'FAILED, objects remain under _probe/' : 'ok'}`);
}

if (problems.length) {
  console.error(`\nBUCKET IS NOT PRIVATE:\n- ${[...new Set(problems)].join('\n- ')}\nFix: docs/DEPLOYMENT.md §2 (Linode Object Storage).`);
  process.exit(1);
}
console.log('\nBucket is private: anonymous read, list and write are all denied.');
