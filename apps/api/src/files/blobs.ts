// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Encrypted file storage (P6), on the data volume or in a B2 bucket (P51: files/objects.ts). Each file has its own 32-byte key and is
// stored as a series of chunks, so large files stream in and out without being held in memory:
//
//   "VPB1"  then per chunk:  [flag 1 byte][length 4 bytes BE][nonce 24 bytes][ciphertext+tag]
//
// XChaCha20-Poly1305 per chunk, with the chunk number and the "last chunk" flag as associated
// data: a changed, reordered, dropped or cut-off chunk fails to decrypt.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pipeline as pipe, Readable, Transform, type TransformCallback } from 'node:stream';

import { xchacha20poly1305 } from '@noble/ciphers/chacha';

import { DiskObjects, NotFound, type ObjectStore } from './objects';

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

/** Seals a buffer held in memory the same way as a stored file (a database snapshot). */
export async function sealBytes(plain: Buffer, key: Uint8Array): Promise<Buffer> {
  return through(new Encrypt(key, Number.MAX_SAFE_INTEGER), plain);
}

/** Opens what sealBytes sealed; BadBlob if it was changed or cut off. */
export async function openBytes(sealed: Buffer, key: Uint8Array): Promise<Buffer> {
  return through(new Decrypt(key), sealed);
}

async function through(t: Transform, input: Buffer): Promise<Buffer> {
  const out: Buffer[] = [];
  t.on('data', (c: Buffer) => out.push(c));
  await new Promise<void>((ok, fail) => {
    t.on('end', ok);
    t.on('error', fail);
    t.end(input);
  });
  return Buffer.concat(out);
}

export interface Stored {
  blobKey: string;
  /** Plaintext size. */
  size: number;
  /** Plaintext sha256, hex. */
  sha256: string;
}

export class BlobStore {
  private primary: ObjectStore;
  /** Where files may still be while a move is under way (P51): read when the primary does not
   *  have a file, and removed from too. Null once a move has finished. */
  private other: ObjectStore | null = null;

  /** The data volume's store, whether or not it is the one in use. */
  readonly local: DiskObjects;

  constructor(dir: string) {
    this.local = new DiskObjects(dir);
    this.primary = this.local;
  }

  /** Where new files go, and where older ones may still be (P51). */
  use(primary: ObjectStore, other: ObjectStore | null): void {
    this.primary = primary;
    this.other = other;
  }

  get where(): { primary: ObjectStore; other: ObjectStore | null } {
    return { primary: this.primary, other: this.other };
  }

  /** Writes under way, so a move can wait for those that began before it switched places. */
  private readonly writing = new Set<Promise<unknown>>();

  /** Files written in the last few minutes: the database may not name them yet (it is told
   *  just after the write), so a move must not take them for unused (P51). */
  private readonly recent = new Map<string, number>();
  private static readonly RECENT_MS = 10 * 60_000;

  /** Waits for every write that has begun so far (P51: after a move switches places). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.writing]);
  }

  /** Written by this server in the last ten minutes. */
  isRecent(blobKey: string): boolean {
    const at = this.recent.get(blobKey);
    return at !== undefined && Date.now() - at < BlobStore.RECENT_MS;
  }

  private noteWritten(blobKey: string): void {
    const now = Date.now();
    for (const [k, at] of this.recent) {
      if (now - at < BlobStore.RECENT_MS) break;
      this.recent.delete(k);
    }
    this.recent.set(blobKey, now);
  }

  /** Encrypts `source` into a new blob; TooLarge past `maxBytes` (nothing is kept). */
  async put(source: Readable, key: Uint8Array, maxBytes: number): Promise<Stored> {
    const job = this.write(source, key, maxBytes);
    this.writing.add(job);
    try {
      return await job;
    } finally {
      this.writing.delete(job);
    }
  }

  private async write(source: Readable, key: Uint8Array, maxBytes: number): Promise<Stored> {
    const blobKey = randomUUID();
    const store = this.primary;
    const enc = new Encrypt(key, maxBytes);
    let tooLarge = false;
    enc.on('error', (err) => {
      if (err instanceof TooLarge) tooLarge = true;
    });
    const body = pipe(source, enc, () => undefined);
    try {
      await store.put(blobKey, body);
    } catch (err) {
      // The place refused it (B2 down past its retries): stop reading the sender too, as a
      // failed pipeline would, so the request's stream is not left open and paused.
      body.destroy();
      if (tooLarge) throw new TooLarge();
      throw err;
    }
    if (tooLarge) {
      await store.remove(blobKey);
      throw new TooLarge();
    }
    this.noteWritten(blobKey);
    return { blobKey, size: enc.size, sha256: enc.hash.digest('hex') };
  }

  /** The stored (encrypted) bytes, from wherever the file is now. While a move is under way, a
   *  file the first place cannot give (not there, or that place is unreachable) is read from the
   *  other; if the other does not have it either, the first place's error is the answer. */
  raw(blobKey: string): Readable {
    const first = this.primary;
    const second = this.other;
    async function* read(): AsyncGenerator<Buffer> {
      const it = first.get(blobKey)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      try {
        let head: IteratorResult<Buffer>;
        try {
          head = await it.next();
        } catch (err) {
          if (!second) throw err;
          const alt = second.get(blobKey)[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
          try {
            let r: IteratorResult<Buffer>;
            try {
              r = await alt.next();
            } catch (err2) {
              throw err2 instanceof NotFound ? err : err2;
            }
            for (; !r.done; r = await alt.next()) yield r.value;
          } finally {
            await alt.return?.();
          }
          return;
        }
        if (!head.done) yield head.value;
        for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
      } finally {
        // A reader that stops early (a download cancelled) closes the source too.
        await it.return?.();
      }
    }
    return Readable.from(read(), { objectMode: false });
  }

  /** The plaintext as a stream; it errors with BadBlob if the blob was changed. */
  get(blobKey: string, key: Uint8Array): Readable {
    // pipeline, not pipe(): a read error (e.g. a missing file) reaches the reader too.
    return pipe(this.raw(blobKey), new Decrypt(key), () => undefined);
  }

  /** Reads and checks the whole blob (used before streaming small previews, and in tests). */
  async read(blobKey: string, key: Uint8Array): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const b of this.get(blobKey, key)) parts.push(b as Buffer);
    return Buffer.concat(parts);
  }

  /**
   * Removes a stored file from both places. Never throws: callers have already changed the
   * database, and what follows (History, marked copies, the answer) must still happen. A file
   * that could not be removed (B2 down) is left for the daily sweep (files/storage.ts, D9).
   * False when it may still be there.
   */
  async remove(blobKey: string): Promise<boolean> {
    let ok = true;
    for (const place of [this.primary, this.other]) {
      if (!place) continue;
      try {
        await place.remove(blobKey);
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  async exists(blobKey: string): Promise<boolean> {
    if (await this.primary.exists(blobKey)) return true;
    return this.other ? this.other.exists(blobKey) : false;
  }
}
