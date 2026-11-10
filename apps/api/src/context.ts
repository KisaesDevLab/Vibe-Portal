// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// What every router needs.

import type { Database } from '@vibe-portal/db';
import { schema } from '@vibe-portal/db';
import type { Logger } from 'pino';

import type { CookieOptions } from './auth/sessions';
import type { B2Settings } from './files/b2';
import type { BlobStore } from './files/blobs';
import type { Keyring } from './files/keyring';
import type { Bucket } from './files/objects';
import type { Message, Notifier } from './lib/notify';

/** The largest file a client may send or Vibe Files may share: under Cloudflare's 100 MB
 *  request limit (Free and Pro plans), which a file of 100 MiB would break. */
export const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;

export interface Ctx {
  db: Database;
  notifier: Notifier;
  log: Logger;
  /** The clock (tests move it). */
  now: () => Date;
  /** The address clients use, without a trailing slash. */
  portalUrl: string;
  cookie: CookieOptions;
  /** Count rate limits by CF-Connecting-IP (behind the Cloudflare Tunnel). */
  trustCfIp: boolean;
  /** Wraps and unwraps each file's key with the firm master key (P6). */
  keyring: Keyring;
  /** Encrypted file storage, on the data volume or in B2 (P51). */
  blobs: BlobStore;
  /** Opens a B2 bucket (P51); tests put a bucket kept in memory in its place. */
  openB2?: (s: B2Settings) => Bucket;
  /** No text messages are set up (SMS_PROVIDER=none): nobody is offered signing in by text
   *  with a number added later (P50). Unset means texts can be sent. */
  textsOff?: boolean;
}

/**
 * Sends without waiting, so the answer to /login takes the same time whether or not the contact
 * is known (QA 2026-11-09). A failure is logged.
 */
export function deliver(ctx: Ctx, msg: Message): void {
  ctx.notifier.send(msg).catch((err: unknown) => {
    ctx.log.error({ err, channel: msg.channel }, 'notification failed');
  });
}

export async function firmName(ctx: Ctx): Promise<string> {
  const [row] = await ctx.db.select({ name: schema.firm.name }).from(schema.firm);
  return row?.name || 'Your accounting firm';
}

/** The firm's per-file size limit (P1, P23). */
export async function uploadLimit(ctx: Ctx): Promise<number> {
  const [row] = await ctx.db.select({ limit: schema.firm.uploadLimitBytes }).from(schema.firm);
  return row?.limit ?? MAX_UPLOAD_BYTES;
}
