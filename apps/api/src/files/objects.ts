// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Where stored files' bytes live (P51): the appliance's data volume, or a Backblaze B2 bucket
// (files/b2.ts). What is stored here is already encrypted (files/blobs.ts): neither place ever
// holds a readable file, and the key that opens them stays on the appliance.

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
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

export interface ObjectStore {
  /** 'local' or 'b2', for logs and the Settings page. */
  readonly kind: 'local' | 'b2';
  /** Stores `body` under `key`; nothing is left behind if `body` fails part-way. */
  put(key: string, body: Readable): Promise<void>;
  /** The bytes. A missing file fails with NotFound at the first read, not before. */
  get(key: string): Readable;
  remove(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Every stored file's key (for moving them). */
  list(): AsyncIterable<string>;
}

export function checkKey(key: string): string {
  if (!OBJECT_KEY.test(key)) throw new Error('bad blob key');
  return key;
}

/** Files on the appliance's data volume (DATA_DIR/blobs). */
export class DiskObjects implements ObjectStore {
  readonly kind = 'local' as const;

  constructor(private readonly dir: string) {}

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

  async *list(): AsyncIterable<string> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const n of names) if (OBJECT_KEY.test(n)) yield n;
  }
}

/** Kept in memory: tests stand it in for a B2 bucket. */
export class MemoryObjects implements ObjectStore {
  readonly kind = 'b2' as const;
  readonly items = new Map<string, Buffer>();
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
  }

  async exists(key: string): Promise<boolean> {
    this.check();
    return this.items.has(key);
  }

  async *list(): AsyncIterable<string> {
    this.check();
    for (const k of [...this.items.keys()]) yield k;
  }
}
