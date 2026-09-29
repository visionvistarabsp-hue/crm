import { createHmac, timingSafeEqual } from 'node:crypto';

const PREFIX = 'sha256=';
const HEX64 = /^[0-9a-f]{64}$/i;

export type SignatureFailure =
  /** No app secret configured, so there is nothing to verify against. */
  | 'missing-secret'
  /** Meta did not send an `X-Hub-Signature-256` header at all. */
  | 'missing-signature'
  /** Header present but not a `sha256=<64 hex>` value. */
  | 'malformed-signature'
  /** Well-formed but the digests differ. */
  | 'mismatch';

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

/**
 * Sign a body the way Meta does. Exported so tests can produce a valid header
 * instead of hard-coding one, which would rot the moment the digest encoding
 * changes.
 */
export function computeMetaSignature(rawBody: string, appSecret: string): string {
  return PREFIX + createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Verify Meta's `X-Hub-Signature-256` against the raw request body.
 *
 * `rawBody` must be the exact bytes received, read via `req.text()` *before*
 * any JSON parsing. Parsing and re-serialising does not reliably round-trip
 * key order, whitespace or number formatting, and Meta signs the bytes it sent,
 * so `req.json()` here would reject valid deliveries. Valid UTF-8 survives the
 * text -> utf8 round trip, so the string form is safe to hash.
 *
 * Every failure is a rejection: there is no "skip if unconfigured" path,
 * because an unsigned webhook is a write endpoint reachable by anyone who
 * learns the URL.
 */
export function verifyMetaSignature(
  rawBody: string,
  signature: string | null | undefined,
  appSecret: string,
): SignatureResult {
  if (!appSecret) return { ok: false, reason: 'missing-secret' };
  if (!signature) return { ok: false, reason: 'missing-signature' };

  const trimmed = signature.trim();
  if (!trimmed.startsWith(PREFIX)) return { ok: false, reason: 'malformed-signature' };

  const providedHex = trimmed.slice(PREFIX.length);
  if (!HEX64.test(providedHex)) return { ok: false, reason: 'malformed-signature' };

  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  const provided = Buffer.from(providedHex, 'hex');
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' };

  // Both operands are 32 bytes at this point, so the length guard above is what
  // keeps timingSafeEqual from throwing on a short buffer.
  return timingSafeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
