// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Addendum 01, layer A: the PDF417 barcode on the back of a driver's licence, read on the
// appliance. zxing-wasm (MIT; zxing-cpp, Apache-2.0), jpeg-js (BSD-3-Clause) and pngjs (MIT)
// decode in a process of their own (barcode-worker.cjs): a phone photo takes seconds and
// hundreds of MB, and a fault in the WebAssembly reader must not end the server (a worker
// thread running it once took the whole process down with a V8 fault as it was stopped).

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** A picture larger than this is not decoded (it is kept, and flagged unreadable). */
export const BARCODE_MAX_PIXELS = 50_000_000;
/** The reader stops turning the picture after this long and answers "not read". */
const BUDGET_MS = 20_000;
const TIMEOUT_MS = 45_000;

/** One at a time: each holds a decoded photo. The rest wait their turn. */
let busy = false;
const waiting: (() => void)[] = [];

export type BarcodeReader = (bytes: Buffer, kind: 'jpeg' | 'png') => Promise<string | null>;

/** The text of the PDF417 barcode in a JPEG or PNG, or null when none could be read. */
export const readBarcodeQueued: BarcodeReader = async (bytes, kind) => {
  if (busy) await new Promise<void>((go) => waiting.push(go));
  else busy = true;
  try {
    return await readBarcodeOffThread(bytes, kind);
  } finally {
    const next = waiting.shift();
    if (next) next();
    else busy = false;
  }
};

interface Answer {
  ok: boolean;
  text?: string | null;
  message?: string;
  /** The most memory the reader's process held, in MB. */
  peakMb?: number;
}
/** The last reader's peak memory in MB (for the Log, and for measuring). */
export let lastPeakMb = 0;

export function readBarcodeOffThread(bytes: Buffer, kind: 'jpeg' | 'png'): Promise<string | null> {
  return new Promise((resolve, reject) => {
    // Plain node (no tsx loader): the reader is a .cjs file.
    const child = fork(fileURLToPath(new URL('./barcode-worker.cjs', import.meta.url)), [], {
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error('barcode reading timed out')));
    }, TIMEOUT_MS);
    child.once('message', (msg: Answer) => {
      lastPeakMb = msg.peakMb ?? 0;
      finish(() =>
        msg.ok ? resolve(msg.text ?? null) : reject(new Error(msg.message ?? 'barcode failed')),
      );
    });
    child.once('error', (err) => finish(() => reject(err)));
    // A reader that dies without an answer must settle at once, not after the timeout.
    child.once('exit', (code, signal) =>
      finish(() => reject(new Error(`barcode reader exited (${code ?? signal}) without result`))),
    );
    child.send({
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      kind,
      maxMegapixels: Math.ceil(BARCODE_MAX_PIXELS / 1_000_000),
      budgetMs: BUDGET_MS,
    });
  });
}
