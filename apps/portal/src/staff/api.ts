// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Calls from the staff page (D13) to /api/staff.

import { ApiError } from '../api';

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
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error');
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
    png_or_jpeg: 'The logo must be a PNG or JPEG file of at most 512 KB.',
    too_large: 'That file is too large (a logo can be at most 512 KB).',
    too_many_requests: 'Too many tries. Wait a few minutes.',
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
  };
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

export const when = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
