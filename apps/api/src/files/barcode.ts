// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Addendum 01, layer A: the PDF417 barcode on the back of a driver's licence, read on the
// appliance. zxing-wasm (MIT; zxing-cpp, Apache-2.0), jpeg-js (BSD-3-Clause) and pngjs (MIT)
// decode in a process of their own (barcode-worker.cjs): a phone photo takes seconds and
// hundreds of MB, and a fault in the WebAssembly reader must not end the server (a worker
// thread running it once took the whole process down with a V8 fault as it was stopped).

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** A picture larger than this is not decoded (it is kept, and flagged unreadable). Owner
 *  2026-11-14: 25 MP, which takes a phone's 12 and 24 MP photos. The reader held 354 MB for
 *  12 MP and 870 MB for 48 MP. */
export const BARCODE_MAX_PIXELS = 25_000_000;
/** The reader stops turning the picture after this long and answers "not read". */
const BUDGET_MS = 20_000;
const TIMEOUT_MS = 45_000;

/** A picture waits this long at most for its turn; past that it is kept unread (and flagged),
 *  so the person's page is answered before a proxy gives up on it. */
const QUEUE_WAIT_MS = 25_000;
/** An exit is taken as "no answer" only this long after it: the answer may arrive just behind. */
const EXIT_GRACE_MS = 500;

/** One at a time: each holds a decoded photo. The rest wait their turn. */
let last: Promise<void> = Promise.resolve();

export type BarcodeReader = (bytes: Buffer, kind: 'jpeg' | 'png') => Promise<string | null>;

/** The text of the PDF417 barcode in a JPEG or PNG, or null when none could be read. */
export const readBarcodeQueued: BarcodeReader = async (bytes, kind) =>
  readInTurn(() => readBarcodeOffThread(bytes, kind));

/** Runs `read` after those before it, or answers null when its turn does not come in time. */
export async function readInTurn(
  read: () => Promise<string | null>,
  waitMs = QUEUE_WAIT_MS,
): Promise<string | null> {
  const before = last;
  let done!: () => void;
  // Whoever comes next waits for this one too.
  last = before.then(() => new Promise<void>((r) => (done = r)));
  let timer: NodeJS.Timeout | undefined;
  const inTime = await Promise.race([
    before.then(() => true),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), waitMs);
    }),
  ]);
  clearTimeout(timer);
  if (!inTime) {
    // Not read: its place in the line is given up when it comes.
    void before.then(() => done());
    return null;
  }
  try {
    return await read();
  } finally {
    done();
  }
}

/** What node needs to start on Linux and Windows; nothing of the portal's own. */
const READER_ENV: NodeJS.ProcessEnv = Object.fromEntries(
  ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR']
    .map((k) => [k, process.env[k]] as const)
    .filter(([, v]) => v !== undefined),
);

interface Answer {
  ok: boolean;
  text?: string | null;
  message?: string;
}

export function readBarcodeOffThread(bytes: Buffer, kind: 'jpeg' | 'png'): Promise<string | null> {
  return new Promise((resolve, reject) => {
    // Plain node (no tsx loader): the reader is a .cjs file.
    const child = fork(fileURLToPath(new URL('./barcode-worker.cjs', import.meta.url)), [], {
      execArgv: [],
      // It reads pictures from strangers: it is given none of the server's settings (the
      // database address, keys), only what node needs to start.
      env: READER_ENV,
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
      finish(() =>
        msg.ok ? resolve(msg.text ?? null) : reject(new Error(msg.message ?? 'barcode failed')),
      );
    });
    child.once('error', (err) => finish(() => reject(err)));
    // A reader that dies without an answer must settle soon, not after the timeout. Not at
    // once: its exit can be seen a moment before the answer it sent.
    child.once('exit', (code, signal) => {
      setTimeout(
        () =>
          finish(() =>
            reject(new Error(`barcode reader exited (${code ?? signal}) without result`)),
          ),
        EXIT_GRACE_MS,
      );
    });
    child.send({
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      kind,
      maxMegapixels: Math.ceil(BARCODE_MAX_PIXELS / 1_000_000),
      budgetMs: BUDGET_MS,
    });
  });
}
