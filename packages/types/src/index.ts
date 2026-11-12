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
  'upload_notice',
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
  'staff_sso',
  'client_updated',
  // A person adds or removes the mobile number they sign in with (P50).
  'phone_added',
  'phone_removed',
  'settings_updated',
  'staff_added',
  'staff_on',
  'staff_off',
  'staff_reset',
  'staff_access',
  'upload_removed',
  'upload_purged',
  'upload_filed',
  'upload_dismissed',
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
  // P66: a secure link sent again (a new link; the old one stops working).
  'outside_share_resent',
  // P66: the People view: a person's account turned off or on, details changed, a new email or
  // number asked for and confirmed, a client added by staff, a sign-in link sent by staff.
  'account_off',
  'account_on',
  'person_updated',
  'contact_change_sent',
  'contact_changed',
  'client_added',
  'sign_in_link_sent',
  // P67: staff (or Vibe Files) looked at an access request's photo ID.
  'id_viewed',
  // Where stored files live (P51): the B2 bucket set or removed, a move asked for and its end.
  'storage_b2_saved',
  'storage_b2_removed',
  'storage_move',
  'storage_moved',
  'storage_swept',
  'storage_sweep_refused',
  'storage_snapshot_failed',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
