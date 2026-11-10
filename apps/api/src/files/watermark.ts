// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The mark across each page of a PDF sent to someone outside the client (P49): who it was sent
// to and the day it was opened, as Vibe Time & Billing's secure share does. It makes a copy
// that leaked traceable; it does not stop a screenshot.

import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/** The largest PDF marked: it is read into memory whole, and marked again each time it opens. */
export const WATERMARK_MAX_BYTES = 30 * 1024 * 1024;

const MAX_TEXT = 120;

/** "Jane Roe - First Bank - viewed 2026-11-10", with middle dots between the parts.
 *  Helvetica writes Latin letters only, so any other character becomes "?". */
export function watermarkText(
  who: { name: string; email: string; organization: string },
  on: Date,
): string {
  const parts = [who.name || who.email, who.organization, `viewed ${on.toISOString().slice(0, 10)}`]
    .map((p) => p.replace(/[^\x20-\x7e\xa0-\xff]/g, '?').trim())
    .filter((p) => p !== '');
  const text = parts.join(' \xb7 ');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 3)}...` : text;
}

/**
 * The PDF with `text` across the middle of every page. It throws when the file is not a PDF
 * that can be read (damaged, or locked with a password): the caller then sends nothing, since
 * an unmarked copy must never go out in place of a marked one.
 */
export async function watermarkPdf(bytes: Uint8Array, text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  if (pages.length === 0) throw new Error('no pages');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const page of pages) {
    const { width, height } = page.getSize();
    const size = Math.max(10, Math.min(width, height) / 30);
    const textWidth = font.widthOfTextAtSize(text, size);
    page.drawText(text, {
      x: Math.max(8, width / 2 - textWidth / 2.4),
      y: height / 2 - size,
      size,
      font,
      color: rgb(0.55, 0.55, 0.6),
      opacity: 0.22,
      rotate: degrees(35),
    });
  }
  return pdf.save();
}
