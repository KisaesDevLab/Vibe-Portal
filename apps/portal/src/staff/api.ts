// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Calls from the staff page (D13) to /api/staff.

import { ApiError } from '../api';

/** An error answer; `detail` is B2's own reason when a bucket check fails (P51). */
export class StaffApiError extends ApiError {
  constructor(
    status: number,
    code: string,
    readonly detail?: string,
  ) {
    super(status, code);
  }
}

export async function staffApi<T>(
  path: string,
  init: { method?: string; body?: unknown; raw?: Blob } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.raw) {
    headers['Content-Type'] = 'application/octet-stream';
    body = init.raw;
  } else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`/api/staff${path}`, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers,
    body,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
  if (!res.ok) throw new StaffApiError(res.status, data.error ?? 'error', data.detail);
  return data as T;
}

/** Plain words for the staff API's error codes. */
export function staffSay(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'network';
  const words: Record<string, string> = {
    sign_in_failed: 'Email, password or code not right.',
    locked: 'Too many wrong tries: this account is locked for 15 minutes.',
    setup_link_expired: 'This setup link has expired or was used. Ask for a new one.',
    code_wrong: 'That code is not right. Check the time on your phone and try the newest code.',
    invalid: 'Check the fields and try again.',
    invalid_email: 'That email address does not look right.',
    email_taken: 'There is already a staff account with that email.',
    name_required: 'Enter your name.',
    not_for_staff: 'Only Vibe Files can do that.',
    cannot_turn_off_yourself: 'You cannot turn off your own account.',
    cannot_change_yourself: 'You cannot change your own access; ask another admin.',
    admins_only: 'Only an admin can do that.',
    all_clients_only: 'Only staff who see every client can do that.',
    admin_sees_all: 'An admin sees every client. Untick Admin to choose clients.',
    already_has_access: 'That person already has access to this client.',
    client_inactive: 'This client is switched off.',
    file_not_found: 'One of those files is no longer on the portal.',
    view_only_needs_preview:
      'View only works for PDFs and pictures (PNG, JPEG). Choose View & download, or leave the other files out.',
    too_large_to_watermark:
      'A PDF over 30 MB cannot be watermarked. Send it without the watermark.',
    cannot_watermark:
      'One of those PDFs cannot be watermarked (it may be locked with a password or damaged). Send it without the watermark.',
    recipient_has_too_many:
      'That person already has 5 secure links for this client that still work. Revoke one first.',
    too_many_shares: 'You have sent 50 secure links today. Try again tomorrow.',
    email_failed:
      'The email could not be sent, so no link was made. Check the address and try again.',
    png_or_jpeg: 'The logo must be a PNG or JPEG file of at most 512 KB.',
    too_large: 'That file is too large (a logo can be at most 512 KB).',
    too_many_requests: 'Too many tries. Wait a few minutes.',
    no_first_admin: 'A staff account exists now: sign in, or ask an admin to add you.',
    signed_out: 'You were signed out. Sign in again.',
    invalid_phone: 'That mobile number does not look right.',
    contact_required: 'Enter an email or a mobile number.',
    client_not_found: 'That client is no longer on the portal.',
    not_found: 'It is no longer there; the page now shows what is.',
    not_a_user_of_this_client: 'That person no longer has access to this client.',
    setup_not_started: 'Set the password first.',
    setup_link_missing:
      'Open the setup link again. If you already added the portal to your authenticator app, remove it there and add it again.',
    cannot_reset_yourself: 'You cannot send yourself a new setup link; ask another staff member.',
    staff_off: 'Turn them on first.',
    invalid_json: 'Something went wrong. Try again.',
    json_required: 'Something went wrong. Try again.',
    network: 'The portal cannot be reached right now.',
    b2_endpoint:
      "The endpoint must be the bucket's S3 endpoint from Backblaze, like s3.us-west-004.backblazeb2.com.",
    b2_bucket: 'A B2 bucket name is 6 to 63 letters, digits and hyphens.',
    b2_app_key: 'Enter the application key.',
    b2_not_set_up: 'Set up the B2 bucket first.',
    b2_in_use:
      'Files are stored in this bucket. Move them back to the appliance before changing the bucket or removing it.',
    move_running: 'A move is already under way.',
    already_there: 'The files are already there.',
    snapshot_not_b2: 'Database snapshots go to the bucket once files are stored there.',
    download_limit: 'This link has been downloaded as many times as it allows.',
    local_login_disabled:
      'Staff sign in with Vibe Auth only. Use the Sign in with Vibe Auth button above.',
    snapshot_busy: 'A database copy is being sent right now. Try again in a minute.',
    share_ended: 'That link has ended or was revoked. Send a new one instead.',
    send_failed: 'The message could not be sent. Check the address or number and try again.',
    notify_unreachable: 'They have no email or number for that. Choose another way.',
    account_off: 'Their account is turned off. Turn it on first.',
    no_access: 'They have no client to sign in to. Add a client first.',
    texts_off: 'Text messages are not set up on this portal.',
    same_contact: 'That is already the one they sign in with.',
    contact_taken: 'Someone else on the portal already signs in with that.',
    only_contact: 'It is the only way they sign in: add an email first.',
  };
  // The portal's own reason (Object Lock, another portal's bucket, no room), in full.
  if ((code === 'b2_refused' || code === 'no_room') && err instanceof StaffApiError && err.detail) {
    return err.detail;
  }
  if (code === 'b2_check_failed') {
    const why = err instanceof StaffApiError && err.detail ? ` B2 said: ${err.detail}` : '';
    return `The bucket could not be used with that key.${why}`;
  }
  return words[code] ?? 'Something went wrong. Try again.';
}

export interface StaffMe {
  email: string;
  name: string;
  firmName: string;
  /** Uses Settings. */
  admin: boolean;
  /** False for someone an admin limited to some clients. */
  allClients: boolean;
  /** Signed in through Vibe Auth (P44). */
  sso?: boolean;
}

export interface StaffRow {
  id: string;
  email: string;
  name: string;
  active: boolean;
  ready: boolean;
  lastSignInAt: string | null;
  admin: boolean;
  /** The only clients they see; null for every client. */
  clientIds: string[] | null;
  /** Clients sending files may ask that this person be told (P56). */
  notifyUploads: boolean;
  /** Emailed about new access requests (P59). */
  notifyAccessRequests: boolean;
}

export interface ClientRow {
  id: string;
  clientCode: string;
  displayName: string;
  active: boolean;
  users: number;
  files: number;
  waiting: number;
}

export interface PortalUser {
  identityId: string;
  name: string;
  email: string | null;
  phone: string | null;
  roleLabel: string;
  active: boolean;
  lastSignInAt: string | null;
  /** P62: every client this person can see (absent from older servers). */
  clients?: { id: string; name: string }[];
}

export interface Invitation {
  invitationId: string;
  name: string;
  email: string | null;
  phone: string | null;
  roleLabel: string;
  expiresAt: string;
  status: 'invited' | 'expired';
}

export interface SharedFile {
  fileId: string;
  name: string;
  size: number;
  taxYear: number | null;
  sharedAt: string;
  sharedBy: string;
  contentUpdatedAt: string | null;
  users: { identityId: string; visible: boolean; viewedAt: string | null }[];
}

/** A secure link sent to someone outside the client (P49). */
export interface OutsideShare {
  id: string;
  email: string;
  name: string;
  organization: string;
  canDownload: boolean;
  watermark: boolean;
  createdAt: string;
  createdBy: string;
  /** Sent by one of the client's people, not the firm (P55). */
  byClient?: boolean;
  /** Downloads so far, and the link's limit (0: none) (P58). */
  downloads: number;
  downloadLimit: number;
  expiresAt: string;
  revokedAt: string | null;
  opens: number;
  lastOpenedAt: string | null;
  status: 'locked' | 'revoked' | 'expired' | 'opened' | 'sent';
  files: { fileId: string; name: string; removed: boolean; downloads?: number }[];
}

export const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
