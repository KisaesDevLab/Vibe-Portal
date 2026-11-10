// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Calls to the portal API. Errors carry the API's stable code.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api/portal${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin',
    headers: init.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error');
  return data as T;
}

export interface Me {
  identity: { id: string; name: string; email: string | null; phone: string | null };
  clients: { id: string; name: string }[];
  activeClientId: string;
  firmName: string;
}

/** Plain words for the API's error codes. */
export function say(err: unknown): string {
  const code = err instanceof ApiError ? err.code : 'network';
  const words: Record<string, string> = {
    invalid_contact: 'Enter an email address or a mobile number.',
    invalid_email: 'That email address does not look right.',
    invalid_phone: 'That phone number does not look right.',
    contact_required: 'Enter an email address or a mobile number.',
    code_wrong: 'That code is not right, or it has expired. Ask for a new one.',
    link_expired: 'This sign-in link has expired or was already used. Ask for a new one.',
    invite_expired:
      'This invitation has expired or was already used. Ask the firm to send a new one.',
    no_access: 'Your access to the portal has ended. Contact the firm.',
    too_many_requests: 'Too many tries. Wait a few minutes and try again.',
    invalid: 'Check the fields and try again.',
    type_not_allowed:
      'This kind of file cannot be sent. Send PDF, photos, Word, Excel, CSV or text.',
    too_large: 'This file is too large to send.',
    batch_full: 'At most 20 files at a time.',
    too_much_waiting:
      'The firm has not yet collected the files already sent. Please try again later.',
    phone_us_only: 'Please give a US or Canadian mobile number, or use your email.',
    photo_unreadable: 'This photo could not be read. Try taking it again or saving it as JPG.',
    already_received: 'The firm has already received this file.',
    code_wait: 'A code was sent a moment ago. Wait a minute before asking for another.',
    too_many_codes:
      'Too many codes were sent for this link today. Try again tomorrow, or ask the firm for a new link.',
    code_locked: 'Too many wrong tries with that code. Send a new code.',
    code_expired: 'That code has expired or was already used. Send a new code.',
    email_failed: 'The email could not be sent. Try again in a few minutes.',
    not_verified: 'This page has locked. Open the link again and enter a new code.',
    view_only: 'This document can be viewed here but not downloaded.',
    network: 'The portal cannot be reached right now. Try again later.',
  };
  return words[code] ?? 'Something went wrong. Try again.';
}

/** The `t` value from a link's #fragment (tokens stay out of server logs). */
export function tokenFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('t') ?? '';
}
