import { describe, it, expect } from 'vitest';
import { computeMetaSignature, verifyMetaSignature } from '@/lib/metaSignature';

const SECRET = 'app-secret-abc123';
const BODY = JSON.stringify({
  object: 'page',
  entry: [{ id: '1', changes: [{ field: 'leadgen', value: { leadgen_id: '9001' } }] }],
});

describe('verifyMetaSignature', () => {
  it('accepts a signature Meta would produce for this exact body', () => {
    const sig = computeMetaSignature(BODY, SECRET);
    expect(verifyMetaSignature(BODY, sig, SECRET)).toEqual({ ok: true });
  });

  it('rejects a tampered body even when the header is well formed', () => {
    const sig = computeMetaSignature(BODY, SECRET);
    const tampered = BODY.replace('9001', '9999');
    expect(verifyMetaSignature(tampered, sig, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects a body signed with a different secret', () => {
    const sig = computeMetaSignature(BODY, 'some-other-secret');
    expect(verifyMetaSignature(BODY, sig, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('does not accept a body re-serialised with different key order', () => {
    const sig = computeMetaSignature('{"a":1,"b":2}', SECRET);
    // Same JSON document, different byte layout. Meta signs bytes, not documents.
    expect(verifyMetaSignature('{"b":2,"a":1}', sig, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects when no app secret is configured instead of allowing a pass', () => {
    const sig = computeMetaSignature(BODY, SECRET);
    expect(verifyMetaSignature(BODY, sig, '')).toEqual({ ok: false, reason: 'missing-secret' });
  });

  it('rejects a missing header', () => {
    expect(verifyMetaSignature(BODY, null, SECRET)).toEqual({ ok: false, reason: 'missing-signature' });
    expect(verifyMetaSignature(BODY, '', SECRET)).toEqual({ ok: false, reason: 'missing-signature' });
  });

  it('rejects a header that is not a sha256 digest', () => {
    expect(verifyMetaSignature(BODY, 'plain-guess', SECRET)).toEqual({ ok: false, reason: 'malformed-signature' });
    expect(verifyMetaSignature(BODY, 'sha1=abc', SECRET)).toEqual({ ok: false, reason: 'malformed-signature' });
    expect(verifyMetaSignature(BODY, 'sha256=zzzz', SECRET)).toEqual({ ok: false, reason: 'malformed-signature' });
    expect(verifyMetaSignature(BODY, 'sha256=deadbeef', SECRET)).toEqual({ ok: false, reason: 'malformed-signature' });
  });

  it('tolerates surrounding whitespace in the header', () => {
    const sig = computeMetaSignature(BODY, SECRET);
    expect(verifyMetaSignature(BODY, `  ${sig}  `, SECRET)).toEqual({ ok: true });
  });

  it('rejects an empty body unless that is what was signed', () => {
    const sig = computeMetaSignature('', SECRET);
    expect(verifyMetaSignature('', sig, SECRET)).toEqual({ ok: true });
    expect(verifyMetaSignature('{}', sig, SECRET)).toEqual({ ok: false, reason: 'mismatch' });
  });
});
