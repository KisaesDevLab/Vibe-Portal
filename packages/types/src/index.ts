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
  'settings_updated',
  'staff_added',
  'staff_on',
  'staff_off',
  'staff_reset',
  'staff_access',
  'upload_removed',
  'upload_purged',
  'file_added',
  'firm_key_created',
  'firm_key_revoked',
  // Files sent to someone outside the client (P49).
  'outside_share',
  'outside_share_revoked',
  'outside_code_sent',
  'outside_verified',
  'outside_view',
  'outside_download',
  'outside_locked',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
