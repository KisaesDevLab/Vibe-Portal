// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Reads or marks one PDF off the main thread (P49): pdf-lib's load and save of a large PDF take
// seconds of CPU, which on the main thread would stop every other request. Started by
// watermark.ts for one job, then ended.
//
//   in:  { op: 'check' | 'mark', bytes: Uint8Array, text?: string }
//   out: { ok: true, bytes?: Uint8Array } or { ok: false, error: string }

import { parentPort } from 'node:worker_threads';

import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';

import { markLayout } from './watermark-layout.mjs';

async function load(bytes) {
  // A PDF locked with a password throws here: it is refused, never sent unmarked.
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  if (pdf.getPageCount() === 0) throw new Error('no pages');
  return pdf;
}

async function mark(bytes, text) {
  const pdf = await load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const widthAtOne = font.widthOfTextAtSize(text, 1);
  for (const page of pdf.getPages()) {
    const at = markLayout(page.getCropBox(), page.getRotation().angle, widthAtOne);
    page.drawText(text, {
      x: at.x,
      y: at.y,
      size: at.size,
      font,
      color: rgb(0.55, 0.55, 0.6),
      opacity: 0.22,
      rotate: degrees(at.angle),
    });
  }
  return pdf.save();
}

parentPort.once('message', async (job) => {
  try {
    if (job.op === 'check') {
      await load(job.bytes);
      parentPort.postMessage({ ok: true });
    } else {
      const out = await mark(job.bytes, job.text);
      parentPort.postMessage({ ok: true, bytes: out }, [out.buffer]);
    }
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err?.message ?? err) });
  }
});
