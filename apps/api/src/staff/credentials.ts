// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff credentials (P9): Argon2id password hashes, and authenticator-app codes (TOTP, RFC 6238:
// HMAC-SHA1, 30-second steps, 6 digits) with base32 secrets for the otpauth:// QR link.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import argon2 from 'argon2';

export const MIN_PASSWORD = 12;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** A hash to verify against when the account does not exist, so the time taken is the same. */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new authenticator secret (160 bits). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The code for `secret` at `time` (RFC 6238). */
export function totpCode(secret: string, time: Date, step = 30, digits = 6): string {
  const counter = Math.floor(time.getTime() / 1000 / step);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The 30-second step `code` is right for: now, or one step either side (clock drift). */
export function totpStep(secret: string, code: string, now: Date): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  for (const drift of [-1, 0, 1]) {
    const at = new Date(now.getTime() + drift * 30_000);
    const want = totpCode(secret, at);
    if (timingSafeEqual(Buffer.from(want), Buffer.from(code))) {
      return Math.floor(at.getTime() / 30_000);
    }
  }
  return null;
}

/** Whether `code` is right now, or one step either side (clock drift). */
export function verifyTotp(secret: string, code: string, now: Date): boolean {
  return totpStep(secret, code, now) !== null;
}

/** The link an authenticator app reads (as a QR code or typed). */
export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${q.toString()}`;
}
