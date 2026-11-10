// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Types shared by the API, the client portal and the staff page.

/** GET /health */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  version: string;
  db: 'ok' | 'down';
}

/** Where a client user's notifications go (P4). */
export type NotifyChannel = 'email' | 'sms' | 'both' | 'none';

/** Kinds of rows in the append-only `events` table. */
export const EVENT_KINDS = [
  'share',
  'unshare',
  'remove',
  'replace',
  'view',
  'download',
  'upload',
  'fetch',
  'invite',
  'invite_revoked',
  'invite_accepted',
  'request',
  'request_confirmed',
  'approve',
  'deny',
  'disable',
  'enable',
  'sign_in',
  'sign_out',
  'staff_sign_in',
  'client_updated',
  'file_added',
  'firm_key_created',
  'firm_key_revoked',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
