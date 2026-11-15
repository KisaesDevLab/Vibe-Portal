// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Addendum 01, layer A: what the barcode on the back of a US or Canadian driver's licence or
// ID says (the AAMVA card design standard's PDF417), and the flags worked out from it.
//
// A barcode can be made by anyone: these fields catch a wrong, old or mistyped ID and give
// staff something to compare. They do not prove the ID is genuine.
//
// P81: the licence number (DAQ) is read past and never returned, so it reaches no table, event
// or log line. (The back picture itself holds it, as the front shows it in print; both are
// kept encrypted and deleted on the same schedule.)

import type { schema } from '@vibe-portal/db';

export type IdScan = schema.IdScan;
export type IdFlag = schema.IdFlag;

/** The elements kept. Anything else in the barcode, the licence number above all, is dropped. */
const KEPT = [
  'DCS',
  'DAC',
  'DAD',
  'DCT',
  'DAA',
  'DAB',
  'DBB',
  'DBA',
  'DBD',
  'DAG',
  'DAI',
  'DAJ',
  'DAK',
  'DCG',
] as const;
type Element = (typeof KEPT)[number];

const pad = (n: number): string => String(n).padStart(2, '0');

/** A real calendar day between 1900 and 2199, as YYYY-MM-DD. */
function day(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * An AAMVA date as YYYY-MM-DD. The United States writes MMDDCCYY, Canada CCYYMMDD (as did the
 * first version of the standard everywhere); a date that reads both ways goes by `yearFirst`.
 */
export function aamvaDate(raw: string | undefined, yearFirst: boolean): string | null {
  const s = (raw ?? '').replace(/\D/g, '');
  if (s.length !== 8) return null;
  const n = (from: number, to: number): number => Number(s.slice(from, to));
  const monthFirst = day(n(4, 8), n(0, 2), n(2, 4));
  const yearLed = day(n(0, 4), n(4, 6), n(6, 8));
  if (monthFirst && yearLed) return yearFirst ? yearLed : monthFirst;
  return monthFirst ?? yearLed;
}

/** "958180000" and "95818" as 95818, "958181234" as 95818-1234; a Canadian code as written. */
function zip(raw: string): string {
  const s = raw.trim();
  const digits = s.replace(/[\s-]/g, '');
  if (/^\d{9}$/.test(digits)) {
    return digits.endsWith('0000')
      ? digits.slice(0, 5)
      : `${digits.slice(0, 5)}-${digits.slice(5)}`;
  }
  return s;
}

/**
 * The fields of an AAMVA barcode, or null when the text is not one. Never the licence number.
 */
export function parseAamva(text: string): IdScan | null {
  const head = /(ANSI |AAMVA)(\d{6})(\d{2})/.exec(text.slice(0, 40));
  if (!head) return null;
  const version = Number(head[3]);
  const got = new Map<Element, string>();
  // Lines end with a line feed, a carriage return or the record separator (U+001E).
  for (const line of text
    .split('\u001e')
    .join('\n')
    .split(/[\r\n]+/)) {
    // The first element of a subfile follows its two-letter name ("DL" or "ID") on the line of
    // the header: "...DLDAQ1234" holds DAQ, which is not kept.
    const start = /(?:DL|ID)(D[A-Z]{2})/.exec(line);
    const rest =
      line.startsWith('ANSI ') || line.startsWith('AAMVA') || line.startsWith('@')
        ? start
          ? line.slice(start.index + 2)
          : ''
        : /^(?:DL|ID)D[A-Z]{2}/.test(line)
          ? line.slice(2)
          : line;
    const id = rest.slice(0, 3) as Element;
    if (KEPT.includes(id) && !got.has(id)) got.set(id, rest.slice(3).trim());
  }
  const v = (id: Element): string => got.get(id) ?? '';
  // Before version 4 the name came whole (DAA "FAMILY,FIRST,MIDDLE") or as DAB and DCT.
  const whole = v('DAA')
    .split(',')
    .map((p) => p.trim());
  const given = v('DCT')
    .split(/[\s,]+/)
    .filter(Boolean);
  const familyName = v('DCS') || v('DAB') || (whole[0] ?? '');
  const firstName = v('DAC') || given[0] || (whole[1] ?? '');
  const middleName = v('DAD') || given.slice(1).join(' ') || (whole[2] ?? '');
  const country = v('DCG').toUpperCase();
  const yearFirst = country === 'CAN' || version === 1;
  const scan: IdScan = {
    familyName,
    firstName,
    middleName: middleName.toUpperCase() === 'NONE' ? '' : middleName,
    dob: aamvaDate(got.get('DBB'), yearFirst),
    expires: aamvaDate(got.get('DBA'), yearFirst),
    issued: aamvaDate(got.get('DBD'), yearFirst),
    address: { street: v('DAG'), city: v('DAI'), state: v('DAJ'), zip: zip(v('DAK')) },
    issuer: [v('DAJ'), country].filter(Boolean).join(', '),
  };
  // A header with nothing under it tells staff nothing: not read.
  if (!scan.familyName && !scan.firstName && !scan.dob) return null;
  return scan;
}

/** Words of a name, compared without case, accents or punctuation. */
function words(name: string): string[] {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .split(/[\s-]+/)
    .filter(Boolean);
}

/**
 * Whether the name on the request and the name in the barcode differ: they do unless the
 * request has the barcode's family name and its first name. Middle names are ignored.
 */
export function nameDiffers(requestName: string, scan: IdScan): boolean {
  const asked = new Set(words(requestName));
  const family = words(scan.familyName);
  const first = words(scan.firstName)[0];
  if (family.length === 0 || !first) return true;
  return !(family.every((w) => asked.has(w)) && asked.has(first));
}

/** YYYY-MM-DD on the appliance's clock. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The flags of a back picture: what its barcode said (null: none could be read). */
export function scanFlags(scan: IdScan | null, requestName: string, now: Date): IdFlag[] {
  if (!scan) return ['unreadable'];
  const flags: IdFlag[] = [];
  if (scan.expires && scan.expires < localDay(now)) flags.push('expired');
  if (nameDiffers(requestName, scan)) flags.push('name_differs');
  return flags;
}
