// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, expect, it } from 'vitest';

import {
  base32Decode,
  base32Encode,
  hashPassword,
  otpauthUrl,
  totpCode,
  verifyPassword,
  verifyTotp,
} from '../staff/credentials';

// RFC 6238 appendix B: the SHA-1 seed "12345678901234567890", 8-digit codes; the 6-digit code
// is the last six digits.
const SEED = base32Encode(Buffer.from('12345678901234567890'));

describe('staff credentials', () => {
  it('base32 round-trips', () => {
    const b = Buffer.from('any bytes, any length!');
    expect(base32Decode(base32Encode(b)).equals(b)).toBe(true);
    expect(SEED).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('matches the RFC 6238 test values', () => {
    for (const [t, eight] of [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ] as const) {
      expect(totpCode(SEED, new Date(t * 1000), 30, 8)).toBe(eight);
      expect(totpCode(SEED, new Date(t * 1000))).toBe(eight.slice(2));
    }
  });

  it('accepts one step of clock drift, not two', () => {
    const now = new Date(1_800_000_000_000);
    expect(verifyTotp(SEED, totpCode(SEED, now), now)).toBe(true);
    expect(verifyTotp(SEED, totpCode(SEED, new Date(now.getTime() - 30_000)), now)).toBe(true);
    expect(verifyTotp(SEED, totpCode(SEED, new Date(now.getTime() + 90_000)), now)).toBe(false);
    expect(verifyTotp(SEED, '12345', now)).toBe(false);
  });

  it('hashes passwords with Argon2id', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not a hash', 'x')).toBe(false);
  });

  it('makes an otpauth link', () => {
    expect(otpauthUrl('Example CPA portal', 'kurt@example.test', 'ABC')).toBe(
      'otpauth://totp/Example%20CPA%20portal%3Akurt%40example.test?secret=ABC&issuer=Example+CPA+portal&algorithm=SHA1&digits=6&period=30',
    );
  });
});
