// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
// Copied from Vibe-Time-Billing apps/api/src/files/extract-for-naming.ts @ 4b14d2f5
// (convertHeicOffThread, looksLikeHeic)
//
// P33: iPhone HEIC photos become JPG on the portal before Vibe Files fetches them.
// heic-convert (ISC) uses libheif-js (LGPL-3.0, unmodified, as in Vibe Time & Billing).

import { Worker } from 'node:worker_threads';

/** HEIC/HEIF: an ISO-BMFF ftyp box with an heic-family brand. */
export function looksLikeHeic(head: Buffer): boolean {
  if (head.length < 12 || head.toString('latin1', 4, 8) !== 'ftyp') return false;
  const brand = head.toString('latin1', 8, 12);
  return ['heic', 'heix', 'heif', 'hevc', 'mif1', 'msf1'].includes(brand);
}

function toUint8(body: Buffer): Uint8Array {
  return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
}

// heic-convert's WASM decode and JS JPEG encode are synchronous and take seconds for a phone
// photo: a short-lived worker thread keeps the server answering meanwhile. The worker loads
// heic-convert relative to this module so it works from src/ (tsx) and dist/.
const HEIC_WORKER_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { createRequire } = require('node:module');
const req = createRequire(workerData.baseUrl);
const convert = req('heic-convert');
convert({ buffer: workerData.buf, format: 'JPEG', quality: workerData.quality })
  .then((out) => parentPort.postMessage({ ok: true, out }))
  .catch((err) => parentPort.postMessage({ ok: false, message: String((err && err.message) || err) }));
`;

const TIMEOUT_MS = 60_000;

export function convertHeicOffThread(body: Buffer, quality = 0.9): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(HEIC_WORKER_SRC, {
      eval: true,
      workerData: { buf: toUint8(body), quality, baseUrl: import.meta.url },
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('heic conversion timed out'))),
      TIMEOUT_MS,
    );
    worker.once('message', (msg: { ok: boolean; out?: Uint8Array; message?: string }) => {
      finish(() =>
        msg.ok && msg.out
          ? resolve(Buffer.from(msg.out))
          : reject(new Error(msg.message ?? 'heic conversion failed')),
      );
    });
    worker.once('error', (err) => finish(() => reject(err)));
    // A worker that dies without a message must settle at once, not after the timeout.
    worker.once('exit', (code) =>
      finish(() => reject(new Error(`heic worker exited (${code}) without result`))),
    );
  });
}
