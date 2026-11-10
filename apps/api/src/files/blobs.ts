// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Encrypted file storage on the data volume (P6). Each file has its own 32-byte key and is
// stored as a series of chunks, so large files stream in and out without being held in memory:
//
//   "VPB1"  then per chunk:  [flag 1 byte][length 4 bytes BE][nonce 24 bytes][ciphertext+tag]
//
// XChaCha20-Poly1305 per chunk, with the chunk number and the "last chunk" flag as associated
// data: a changed, reordered, dropped or cut-off chunk fails to decrypt.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pipeline as pipe, Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { xchacha20poly1305 } from '@noble/ciphers/chacha';

export const CHUNK = 1024 * 1024;
const MAGIC = Buffer.from('VPB1');
const NONCE = 24;
const TAG = 16;
const HEADER = 1 + 4 + NONCE;

export class TooLarge extends Error {
  constructor() {
    super('too_large');
  }
}
export class BadBlob extends Error {
  constructor(why: string) {
    super(`blob unreadable: ${why}`);
  }
}

function aad(index: number, last: boolean): Uint8Array {
  const a = Buffer.alloc(9);
  a.writeBigUInt64BE(BigInt(index));
  a[8] = last ? 1 : 0;
  return a;
}

class Encrypt extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private index = 0;
  private started = false;
  private plainBytes = 0;
  readonly hash = createHash('sha256');

  constructor(
    private readonly key: Uint8Array,
    private readonly maxBytes: number,
  ) {
    super();
  }

  get size(): number {
    return this.plainBytes;
  }

  private emit_(plain: Buffer, last: boolean): void {
    if (!this.started) {
      this.push(MAGIC);
      this.started = true;
    }
    const nonce = randomBytes(NONCE);
    const ct = xchacha20poly1305(this.key, nonce, aad(this.index, last)).encrypt(plain);
    const head = Buffer.alloc(5);
    head[0] = last ? 1 : 0;
    head.writeUInt32BE(ct.length, 1);
    this.push(Buffer.concat([head, nonce, ct]));
    this.index += 1;
  }

  override _transform(data: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.plainBytes += data.length;
    if (this.plainBytes > this.maxBytes) {
      done(new TooLarge());
      return;
    }
    this.hash.update(data);
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    // Keep at least one byte back so the last chunk is always known at flush.
    while (this.buf.length > CHUNK) {
      this.emit_(this.buf.subarray(0, CHUNK), false);
      this.buf = this.buf.subarray(CHUNK);
    }
    done();
  }

  override _flush(done: TransformCallback): void {
    this.emit_(this.buf, true);
    done();
  }
}

class Decrypt extends Transform {
  private buf: Buffer = Buffer.alloc(0);
  private index = 0;
  private magicSeen = false;
  private finished = false;

  constructor(private readonly key: Uint8Array) {
    super();
  }

  override _transform(data: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    try {
      this.drain();
      done();
    } catch (err) {
      done(err as Error);
    }
  }

  private drain(): void {
    if (!this.magicSeen) {
      if (this.buf.length < MAGIC.length) return;
      if (!this.buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new BadBlob('not a portal file');
      this.buf = this.buf.subarray(MAGIC.length);
      this.magicSeen = true;
    }
    while (this.buf.length >= HEADER) {
      if (this.finished) throw new BadBlob('data after the last chunk');
      const last = this.buf[0] === 1;
      const len = this.buf.readUInt32BE(1);
      if (len < TAG || len > CHUNK + TAG) throw new BadBlob('bad chunk length');
      if (this.buf.length < HEADER + len) return;
      const nonce = this.buf.subarray(5, HEADER);
      const ct = this.buf.subarray(HEADER, HEADER + len);
      let plain: Uint8Array;
      try {
        plain = xchacha20poly1305(this.key, nonce, aad(this.index, last)).decrypt(ct);
      } catch {
        throw new BadBlob('chunk failed to decrypt');
      }
      this.push(Buffer.from(plain));
      this.buf = this.buf.subarray(HEADER + len);
      this.index += 1;
      if (last) this.finished = true;
    }
  }

  override _flush(done: TransformCallback): void {
    if (!this.finished || this.buf.length) done(new BadBlob('cut off'));
    else done();
  }
}

export interface Stored {
  blobKey: string;
  /** Plaintext size. */
  size: number;
  /** Plaintext sha256, hex. */
  sha256: string;
}

export class BlobStore {
  constructor(private readonly dir: string) {}

  private path(blobKey: string): string {
    if (!/^[0-9a-f-]{36}$/.test(blobKey)) throw new Error('bad blob key');
    return join(this.dir, blobKey);
  }

  /** Encrypts `source` into a new blob; TooLarge past `maxBytes` (nothing is kept). */
  async put(source: Readable, key: Uint8Array, maxBytes: number): Promise<Stored> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const blobKey = randomUUID();
    const tmp = join(this.dir, `${blobKey}.part`);
    const enc = new Encrypt(key, maxBytes);
    try {
      await pipeline(source, enc, createWriteStream(tmp, { mode: 0o600 }));
      await rename(tmp, this.path(blobKey));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { blobKey, size: enc.size, sha256: enc.hash.digest('hex') };
  }

  /** The plaintext as a stream; it errors with BadBlob if the blob was changed. */
  get(blobKey: string, key: Uint8Array): Readable {
    // pipeline, not pipe(): a read error (e.g. a missing file) reaches the reader too.
    return pipe(createReadStream(this.path(blobKey)), new Decrypt(key), () => undefined);
  }

  /** Reads and checks the whole blob (used before streaming small previews, and in tests). */
  async read(blobKey: string, key: Uint8Array): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const b of this.get(blobKey, key)) parts.push(b as Buffer);
    return Buffer.concat(parts);
  }

  async remove(blobKey: string): Promise<void> {
    await rm(this.path(blobKey), { force: true });
  }

  async exists(blobKey: string): Promise<boolean> {
    try {
      await stat(this.path(blobKey));
      return true;
    } catch {
      return false;
    }
  }
}
