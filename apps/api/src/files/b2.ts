// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Stored files in a Backblaze B2 bucket (P51), through B2's S3-compatible API. After
// Vibe-Time-Billing's packages/storage/src/b2.ts (see VENDORED.md), cut down to what the portal
// needs. Files are already encrypted before they get here; the bucket holds them under
// "blobs/<uuid>".
//
// B2 keeps old versions of a file: an S3 delete without a version only hides it. Removing a file
// here deletes every version, so a file removed from the portal is gone from the bucket too (D9).

import { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import { checkKey, checkNote, NotFound, type Bucket, type Listed } from './objects';

export interface B2Settings {
  /** The bucket's S3 endpoint, as B2 shows it: s3.<region>.backblazeb2.com */
  endpoint: string;
  bucket: string;
  keyId: string;
  appKey: string;
}

const ENDPOINT = /^(?:https:\/\/)?(s3\.([a-z0-9-]+)\.backblazeb2\.com)\/?$/;
/** B2 bucket names: 6 to 63 letters, digits and hyphens. */
const BUCKET = /^[A-Za-z0-9-]{6,63}$/;
const PREFIX = 'blobs/';
/** The portal's own notes (its mark on the bucket, database snapshots), apart from files. */
const NOTES = 'portal/';

/** The endpoint's host and region, or null unless it is a Backblaze S3 endpoint. */
export function parseEndpoint(endpoint: string): { host: string; region: string } | null {
  const m = ENDPOINT.exec(endpoint.trim().toLowerCase());
  return m?.[1] && m[2] ? { host: m[1], region: m[2] } : null;
}

export function validBucket(bucket: string): boolean {
  return BUCKET.test(bucket);
}

function status(err: unknown): number | undefined {
  return (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function missing(err: unknown): boolean {
  const e = err as { name?: string };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || status(err) === 404;
}

async function drain(body: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of body) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

export class B2Objects implements Bucket {
  readonly kind = 'b2' as const;
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(s: B2Settings) {
    const at = parseEndpoint(s.endpoint);
    if (!at) throw new Error('not a Backblaze B2 S3 endpoint');
    if (!validBucket(s.bucket)) throw new Error('not a B2 bucket name');
    this.bucket = s.bucket;
    this.s3 = new S3Client({
      endpoint: `https://${at.host}`,
      region: at.region,
      credentials: { accessKeyId: s.keyId, secretAccessKey: s.appKey },
      forcePathStyle: true,
      maxAttempts: 5,
      // A B2 that stops answering must not hang a download or a move for good: give up on a
      // connection after 10 s, and on a socket with nothing moving for 60 s (an idle limit, not
      // a cap on the whole transfer, so a large file on a slow line still gets through). With
      // five attempts the longest wait is about five minutes.
      requestHandler: { connectionTimeout: 10_000, socketTimeout: 60_000 },
    });
  }

  private name(key: string): string {
    return `${PREFIX}${checkKey(key)}`;
  }

  async put(key: string, body: Readable): Promise<void> {
    // Sent in parts as it streams in (its length is not known ahead); a body that fails
    // part-way aborts the upload, so no part is left in the bucket.
    const up = new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: this.name(key), Body: body },
      partSize: 8 * 1024 * 1024,
      queueSize: 2,
      leavePartsOnError: false,
    });
    await up.done();
  }

  get(key: string): Readable {
    const name = this.name(key);
    const read = async function* (this: B2Objects): AsyncGenerator<Buffer> {
      let body: Readable;
      try {
        const out = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: name }));
        body = out.Body as Readable;
      } catch (err) {
        if (missing(err)) throw new NotFound(key);
        throw err;
      }
      for await (const chunk of body) yield chunk as Buffer;
    }.bind(this);
    return Readable.from(read(), { objectMode: false });
  }

  async remove(key: string): Promise<void> {
    await this.removeAll(this.name(key));
  }

  private async removeAll(name: string): Promise<void> {
    // Every version and delete marker of this one file (the prefix also matches longer names).
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: name,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      );
      const all = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])];
      for (const v of all) {
        if (v.Key !== name || !v.VersionId) continue;
        await this.s3.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: name, VersionId: v.VersionId }),
        );
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.name(key) }));
      return true;
    } catch (err) {
      if (missing(err)) return false;
      throw err;
    }
  }

  private async *listed(prefix: string): AsyncIterable<Listed> {
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        if (!o.Key?.startsWith(prefix)) continue;
        yield {
          key: o.Key.slice(prefix.length),
          size: o.Size ?? 0,
          modified: o.LastModified ?? new Date(0),
        };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async *list(): AsyncIterable<Listed> {
    for await (const o of this.listed(PREFIX)) if (/^[0-9a-f-]{36}$/.test(o.key)) yield o;
  }

  async objectLock(): Promise<boolean | null> {
    try {
      const out = await this.s3.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.bucket }),
      );
      return out.ObjectLockConfiguration?.ObjectLockEnabled === 'Enabled';
    } catch (err) {
      const name = (err as { name?: string })?.name ?? '';
      if (name === 'ObjectLockConfigurationNotFoundError' || status(err) === 404) return false;
      // A key limited to the bucket may not be allowed to ask: unknown, not a refusal. The
      // check's own delete still finds a retention rule that would stop removes.
      if (status(err) === 403 || name === 'AccessDenied') return null;
      throw err;
    }
  }

  async putNote(name: string, body: Buffer): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: `${NOTES}${checkNote(name)}`, Body: body }),
    );
  }

  async getNote(name: string): Promise<Buffer | null> {
    try {
      const out = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: `${NOTES}${checkNote(name)}` }),
      );
      return await drain(out.Body as Readable);
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  }

  async *notes(prefix: string): AsyncIterable<{ name: string; size: number; modified: Date }> {
    for await (const o of this.listed(`${NOTES}${prefix}`)) {
      yield { name: `${prefix}${o.key}`, size: o.size, modified: o.modified };
    }
  }

  async removeNote(name: string): Promise<void> {
    await this.removeAll(`${NOTES}${checkNote(name)}`);
  }
}
