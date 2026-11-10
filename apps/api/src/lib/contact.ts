// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
// Copied from Vibe-Time-Billing packages/core/src/auth/{sms-otp,email}.ts @ 4b14d2f5
//
// Email and phone normalisation: the stored form is the dedup key.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A trimmed, lowercased email, or null if it isn't a valid address. */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const e = input.trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

/** Normalize a US phone to E.164 (best-effort). */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = input.replace(/\D+/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (input.trim().startsWith('+') && digits.length >= 10) return `+${digits}`;
  return null;
}

/** Phone-like vs email-like. */
export function detectLoginKind(raw: string): 'email' | 'phone' | 'unknown' {
  const trimmed = raw.trim();
  if (trimmed.includes('@') && EMAIL_RE.test(trimmed)) return 'email';
  if (normalizePhone(trimmed)) return 'phone';
  return 'unknown';
}

/** "j***@example.com" or "***-***-1234", for screens shown before sign-in. */
export function maskContact(contact: string): string {
  if (contact.includes('@')) {
    const [user = '', domain = ''] = contact.split('@');
    return `${user.slice(0, 1)}***@${domain}`;
  }
  return `***-***-${contact.slice(-4)}`;
}
