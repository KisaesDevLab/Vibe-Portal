// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// What every router needs.

import type { Database } from '@vibe-portal/db';
import { schema } from '@vibe-portal/db';
import type { Logger } from 'pino';

import type { CookieOptions } from './auth/sessions';
import type { BlobStore } from './files/blobs';
import type { Keyring } from './files/keyring';
import type { Message, Notifier } from './lib/notify';

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
  /** Encrypted file storage on the data volume. */
  blobs: BlobStore;
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
  return row?.limit ?? 100 * 1024 * 1024;
}
