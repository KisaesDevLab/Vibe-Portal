// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Where stored files' bytes live (P51): the appliance's data volume, or a Backblaze B2 bucket
// (files/b2.ts). What is stored here is already encrypted (files/blobs.ts): neither place ever
// holds a readable file, and the key that opens them stays on the appliance.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** A stored file's name: a UUID, nothing a path or a bucket could misread. */
export const OBJECT_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The stored file is not there. Any other failure (network, permission) is not this. */
export class NotFound extends Error {
  constructor(key: string) {
    super(`stored file not found: ${key}`);
  }
}

/** A stored file as a listing shows it. */
export interface Listed {
  key: string;
  /** Stored (encrypted) size in bytes. */
  size: number;
  /** When the place last wrote it, by that place's clock. */
  modified: Date;
}

export interface ObjectStore {
  /** 'local' or 'b2', for logs and the Settings page. */
  readonly kind: 'local' | 'b2';
  /** Stores `body` under `key`; nothing is left behind if `body` fails part-way. */
  put(key: string, body: Readable): Promise<void>;
  /** The bytes. A missing file fails with NotFound at the first read, not before. */
  get(key: string): Readable;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Every stored file (for moving them and sweeping up leftovers). */
  list(): AsyncIterable<Listed>;
}

/** A name for the bucket's own notes (the portal's mark, database snapshots): kept apart from
 *  stored files, so moving and sweeping never see them. */
const NOTE = /^[a-z0-9][a-z0-9._-]{0,80}(\/[a-z0-9][a-z0-9._-]{0,80})?$/;
export function checkNote(name: string): string {
  if (!NOTE.test(name)) throw new Error('bad note name');
  return name;
}

/** A B2 bucket (P51): stored files, plus the portal's own notes beside them. */
export interface Bucket extends ObjectStore {
  readonly kind: 'b2';
  /** Object Lock is on (files could not be deleted); null when the key may not ask. */
  objectLock(): Promise<boolean | null>;
  putNote(name: string, body: Buffer): Promise<void>;
  /** The note, or null when there is none. */
  getNote(name: string): Promise<Buffer | null>;
  /** Notes whose name starts with `prefix`. */
  notes(prefix: string): AsyncIterable<{ name: string; size: number; modified: Date }>;
  /** Removes the note with every version of it. */
  removeNote(name: string): Promise<void>;
}

export function checkKey(key: string): string {
  if (!OBJECT_KEY.test(key)) throw new Error('bad blob key');
  return key;
}

/** Files on the appliance's data volume (DATA_DIR/blobs). */
export class DiskObjects implements ObjectStore {
  readonly kind = 'local' as const;

  constructor(private readonly dir: string) {}

  /** Free space on the data volume, in bytes (a move back checks it first). Tests replace it. */
  freeBytes = async (): Promise<number> => {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const s = await statfs(this.dir);
    return Number(s.bavail) * Number(s.bsize);
  };

  private path(key: string): string {
    return join(this.dir, checkKey(key));
  }

  async put(key: string, body: Readable): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = join(this.dir, `${checkKey(key)}.part`);
    try {
      await pipeline(body, createWriteStream(tmp, { mode: 0o600 }));
      await rename(tmp, this.path(key));
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  get(key: string): Readable {
    const path = this.path(key);
    async function* read(): AsyncGenerator<Buffer> {
      try {
        for await (const chunk of createReadStream(path)) yield chunk as Buffer;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFound(key);
        throw err;
      }
    }
    return Readable.from(read(), { objectMode: false });
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.path(key));
      return true;
    } catch {
      return false;
    }
  }

  async *list(): AsyncIterable<Listed> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (!OBJECT_KEY.test(n)) continue;
      try {
        const s = await stat(join(this.dir, n));
        yield { key: n, size: s.size, modified: s.mtime };
      } catch {
        // Removed since the folder was read.
      }
    }
  }
}

/** Kept in memory: tests stand it in for a B2 bucket. */
export class MemoryObjects implements Bucket {
  readonly kind = 'b2' as const;
  readonly items = new Map<string, Buffer>();
  /** When each item was written (tests move it back to make a file old). */
  readonly modified = new Map<string, Date>();
  readonly noteItems = new Map<string, { body: Buffer; modified: Date }>();
  /** What objectLock() answers. */
  locked: boolean | null = false;
  /** Set to make every call fail as a network error would. */
  down = false;
  /** Writes allowed before writes start failing (a connection lost part-way through a move). */
  putsLeft = Infinity;

  private check(): void {
    if (this.down) throw new Error('network down');
  }

  async put(key: string, body: Readable): Promise<void> {
    this.check();
    if (this.putsLeft <= 0) throw new Error('connection lost');
    this.putsLeft -= 1;
    const parts: Buffer[] = [];
    for await (const c of body) parts.push(Buffer.from(c as Buffer));
    this.check();
    this.items.set(checkKey(key), Buffer.concat(parts));
    this.modified.set(key, new Date());
  }

  get(key: string): Readable {
    const read = async function* (this: MemoryObjects): AsyncGenerator<Buffer> {
      this.check();
      const b = this.items.get(key);
      if (!b) throw new NotFound(key);
      yield b;
    }.bind(this);
    return Readable.from(read(), { objectMode: false });
  }

  async remove(key: string): Promise<void> {
    this.check();
    this.items.delete(key);
    this.modified.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    this.check();
    return this.items.has(key);
  }

  async *list(): AsyncIterable<Listed> {
    this.check();
    for (const [key, b] of [...this.items]) {
      yield { key, size: b.length, modified: this.modified.get(key) ?? new Date() };
    }
  }

  async objectLock(): Promise<boolean | null> {
    this.check();
    return this.locked;
  }

  async putNote(name: string, body: Buffer): Promise<void> {
    this.check();
    this.noteItems.set(checkNote(name), { body: Buffer.from(body), modified: new Date() });
  }

  async getNote(name: string): Promise<Buffer | null> {
    this.check();
    return this.noteItems.get(checkNote(name))?.body ?? null;
  }

  async *notes(prefix: string): AsyncIterable<{ name: string; size: number; modified: Date }> {
    this.check();
    for (const [name, n] of [...this.noteItems]) {
      if (name.startsWith(prefix)) yield { name, size: n.body.length, modified: n.modified };
    }
  }

  async removeNote(name: string): Promise<void> {
    this.check();
    this.noteItems.delete(checkNote(name));
  }
}
