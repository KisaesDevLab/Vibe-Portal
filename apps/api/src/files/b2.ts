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
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

import { checkKey, NotFound, type ObjectStore } from './objects';

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

/** The endpoint's host and region, or null unless it is a Backblaze S3 endpoint. */
export function parseEndpoint(endpoint: string): { host: string; region: string } | null {
  const m = ENDPOINT.exec(endpoint.trim().toLowerCase());
  return m?.[1] && m[2] ? { host: m[1], region: m[2] } : null;
}

export function validBucket(bucket: string): boolean {
  return BUCKET.test(bucket);
}

function missing(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

export class B2Objects implements ObjectStore {
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
    const name = this.name(key);
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

  async *list(): AsyncIterable<string> {
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: PREFIX, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        const k = o.Key?.slice(PREFIX.length);
        if (k && /^[0-9a-f-]{36}$/.test(k)) yield k;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}
