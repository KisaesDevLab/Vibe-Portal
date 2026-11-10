// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The mark across each page of a PDF sent to someone outside the client (P49): who it was sent
// to and the day it was opened, as Vibe Time & Billing's secure share does. It makes a copy
// that leaked traceable; it does not stop a screenshot.
//
// Reading and marking run in a worker thread (watermark-worker.mjs), a few at a time, so a large
// PDF never holds up other requests. A marked copy is kept per link, file and day
// (files/marks.ts), so a PDF is marked once a day, not on every view.

import { Worker } from 'node:worker_threads';

export const WATERMARK_MAX_BYTES = 30 * 1024 * 1024;

const MAX_TEXT = 120;
/** Workers at once: each holds a PDF (up to 30 MB) and pdf-lib's copy of it. */
const MAX_WORKERS = 2;
/** A job that takes longer is ended and counts as a PDF that cannot be read. */
const JOB_SECONDS = 120;

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

/** The worker read the file and found it is not a PDF it can mark (damaged, or a password).
 *  A timeout or a worker that died is not this: the same file may well work next time. */
export class NotMarkable extends Error {}

type Job = { op: 'check'; bytes: Uint8Array } | { op: 'mark'; bytes: Uint8Array; text: string };
type Reply = { ok: true; bytes?: Uint8Array } | { ok: false; error: string };

let running = 0;
const waiting: Array<() => void> = [];

async function slot(): Promise<void> {
  if (running < MAX_WORKERS) {
    running += 1;
    return;
  }
  // The slot is handed over by the job that ends, so `running` stays as it is.
  await new Promise<void>((ok) => waiting.push(ok));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

async function run(job: Job): Promise<Uint8Array | undefined> {
  await slot();
  try {
    return await new Promise<Uint8Array | undefined>((resolve, reject) => {
      const w = new Worker(new URL('./watermark-worker.mjs', import.meta.url));
      const timer = setTimeout(() => {
        void w.terminate();
        reject(new Error('timed out'));
      }, JOB_SECONDS * 1000);
      const done = (): void => {
        clearTimeout(timer);
        void w.terminate();
      };
      w.once('message', (r: Reply) => {
        done();
        if (r.ok) resolve(r.bytes);
        else reject(new NotMarkable(r.error));
      });
      w.once('error', (err) => {
        done();
        reject(err);
      });
      w.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`worker ended (${code})`));
      });
      // Copied, not transferred: the caller's buffer may be a slice of a pooled one.
      w.postMessage(job);
    });
  } finally {
    release();
  }
}

/** Throws unless `bytes` is a PDF that can be read and so marked (not damaged, no password). */
export async function checkPdf(bytes: Uint8Array): Promise<void> {
  await run({ op: 'check', bytes });
}

/**
 * The PDF with `text` across the middle of every page. It throws when the file is not a PDF
 * that can be read (damaged, or locked with a password): the caller then sends nothing, since
 * an unmarked copy must never go out in place of a marked one.
 */
export async function watermarkPdf(bytes: Uint8Array, text: string): Promise<Uint8Array> {
  const out = await run({ op: 'mark', bytes, text });
  if (!out) throw new Error('nothing marked');
  return out;
}
