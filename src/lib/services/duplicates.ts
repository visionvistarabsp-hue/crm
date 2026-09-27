import { normalizeEmail, normalizePhone } from '../utils';

export interface DuplicateMatch {
  rule: 'PHONE' | 'EMAIL' | 'WHATSAPP';
  confidence: number; // 0-100
}

/**
 * Pure duplicate detection. Two leads are duplicates when the normalized
 * phone or normalized email match exactly. WhatsApp fallback reuses the phone
 * normalization so +91 / 0 prefixes never hide a duplicate.
 */
export function detectDuplicateCandidates(
  candidate: { phone?: string | null; whatsapp?: string | null; email?: string | null },
  existing: Array<{
    phone?: string | null;
    whatsapp?: string | null;
    email?: string | null;
  }>,
): Array<{ index: number; match: DuplicateMatch }> {
  const cPhone = normalizePhone(candidate.phone);
  const cWhats = normalizePhone(candidate.whatsapp);
  const cEmail = normalizeEmail(candidate.email);
  const found: Array<{ index: number; match: DuplicateMatch }> = [];

  existing.forEach((row, index) => {
    const ePhone = normalizePhone(row.phone);
    const eWhats = normalizePhone(row.whatsapp);
    const eEmail = normalizeEmail(row.email);

    if (cPhone && (ePhone === cPhone || eWhats === cPhone)) {
      found.push({ index, match: { rule: 'PHONE', confidence: 100 } });
      return;
    }
    if (cWhats && (ePhone === cWhats || eWhats === cWhats)) {
      found.push({ index, match: { rule: 'PHONE', confidence: 95 } });
      return;
    }
    if (cEmail && eEmail === cEmail) {
      found.push({ index, match: { rule: 'EMAIL', confidence: 100 } });
    }
  });

  return found;
}

export { normalizePhone, normalizeEmail };