// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P29: what clients may upload, checked by the file's first bytes as well as its name. PDF;
// JPG/PNG/HEIC/TIFF; Word/Excel (old and new); CSV; TXT. Anything else is refused.

import { looksLikeHeic } from './heic';

export type Kind = 'pdf' | 'jpeg' | 'png' | 'heic' | 'tiff' | 'office-zip' | 'office-ole' | 'text';

/** The extensions each kind may have. */
const NAMES: Record<Kind, string[]> = {
  pdf: ['pdf'],
  jpeg: ['jpg', 'jpeg'],
  png: ['png'],
  heic: ['heic', 'heif'],
  tiff: ['tif', 'tiff'],
  'office-zip': ['docx', 'xlsx'],
  'office-ole': ['doc', 'xls'],
  text: ['csv', 'txt'],
};

/** How many bytes the check needs to see. */
export const SNIFF_BYTES = 8192;

/** The kind by content alone (P67: a photo ID's name is not needed). */
export function kindOf(head: Buffer): Kind | null {
  const starts = (hex: string): boolean => head.subarray(0, hex.length / 2).toString('hex') === hex;
  if (head.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return 'pdf';
  if (starts('ffd8ff')) return 'jpeg';
  if (starts('89504e470d0a1a0a')) return 'png';
  if (starts('49492a00') || starts('4d4d002a')) return 'tiff';
  if (looksLikeHeic(head)) return 'heic';
  if (starts('504b0304')) return 'office-zip';
  if (starts('d0cf11e0a1b11ae1')) return 'office-ole';
  // Text: no NUL bytes and valid UTF-8 (allowing a character cut at the end of the sample).
  if (head.length > 0 && !head.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(
        head.subarray(0, Math.max(0, head.length - 4)),
      );
      return 'text';
    } catch {
      return null;
    }
  }
  return null;
}

/** The kind when the content and the name agree; null when the file is not allowed. */
export function allowedKind(head: Buffer, name: string): Kind | null {
  const kind = kindOf(head);
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return kind && NAMES[kind].includes(ext) ? kind : null;
}
