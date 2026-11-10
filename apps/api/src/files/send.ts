// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Streams a stored file to a response, decrypting as it goes; reads one whole into memory; and
// reads the start of a request body without losing it.

import { Readable } from 'node:stream';

import type { Response } from 'express';

import type { Ctx } from '../context';
import { HttpError } from '../lib/http';
import { disposition } from './types';

export interface Sendable {
  id: string;
  blobKey: string;
  dekWrapped: Buffer;
  size: number;
  name: string;
  /** Sent as this type and opened in the browser; otherwise a download. */
  inlineType: string | null;
}

/**
 * Sends the file. The first chunk is decrypted before anything is sent, so a damaged or missing
 * file is an error response, not half a file; damage further in breaks the download.
 * `beforeBody` runs once the file is known to be readable (marking it viewed, recording it).
 */
export async function sendStored(
  ctx: Ctx,
  res: Response,
  f: Sendable,
  beforeBody: () => Promise<void>,
): Promise<void> {
  const dek = ctx.keyring.unwrap(new Uint8Array(f.dekWrapped));
  const it = ctx.blobs.get(f.blobKey, dek)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  let first: IteratorResult<Buffer>;
  try {
    first = await it.next();
  } catch (err) {
    ctx.log.error({ err, id: f.id }, 'stored file failed to decrypt');
    throw new HttpError(500, 'file_unreadable');
  }
  res.setHeader('Content-Type', f.inlineType ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', disposition(f.inlineType ? 'inline' : 'attachment', f.name));
  res.setHeader('Content-Length', String(f.size));
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  await beforeBody();
  if (!first.done) res.write(first.value);
  try {
    for (let next = await it.next(); !next.done; next = await it.next()) {
      if (!res.write(next.value)) await new Promise((ok) => res.once('drain', ok));
    }
    res.end();
  } catch (err) {
    ctx.log.error({ err, id: f.id }, 'stored file failed to decrypt part-way');
    res.destroy(err as Error);
  }
}

/** The whole plaintext of a stored file, in memory (for a PDF to check or mark); 500 when it
 *  cannot be decrypted, as `sendStored` answers. */
export async function readPlain(
  ctx: Ctx,
  f: Pick<Sendable, 'id' | 'blobKey' | 'dekWrapped'>,
): Promise<Buffer> {
  try {
    return await ctx.blobs.read(f.blobKey, ctx.keyring.unwrap(new Uint8Array(f.dekWrapped)));
  } catch (err) {
    ctx.log.error({ err, id: f.id }, 'stored file failed to decrypt');
    throw new HttpError(500, 'file_unreadable');
  }
}

/** Reads at least `n` bytes (or all, if shorter) from `src`; `all` replays them and the rest. */
export async function peek(src: Readable, n: number): Promise<{ head: Buffer; all: Readable }> {
  const it = src[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const parts: Buffer[] = [];
  let len = 0;
  let ended = false;
  while (len < n) {
    const r = await it.next();
    if (r.done) {
      ended = true;
      break;
    }
    parts.push(r.value);
    len += r.value.length;
  }
  const head = Buffer.concat(parts);
  async function* replay(): AsyncGenerator<Buffer> {
    yield head;
    if (ended) return;
    for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
  }
  return { head, all: Readable.from(replay()) };
}
