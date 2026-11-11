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
  /** Texts are set up, so a mobile number can be added (P50). */
  textsOn?: boolean;
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
    account_off: 'This account is turned off. Contact your accountant.',
    id_required: 'Add a photo of your ID first.',
    image_too_large: 'That picture is too large. Take a new photo or send a smaller copy.',
    request_closed: 'This request has already been sent. Start a new request if something changed.',
    id_type: 'The photo ID must be a picture (JPEG, PNG or HEIC) or a PDF.',
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
    phone_in_use:
      'That number is already used to sign in to another portal account. Ask the firm for help.',
    phone_already_yours: 'You already sign in with that number.',
    phone_only_contact: 'This number is how you sign in, so it cannot be removed.',
    texts_off: 'This portal does not send text messages. Sign in by email.',
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
    // Secure links a client sends (P55), downloads (P58) and upload notices (P56).
    recipient_has_too_many:
      'That person already has 5 working links for these files. End an old link first.',
    too_many_shares: 'You have sent as many links as you can today. Try again tomorrow.',
    cannot_watermark:
      'This PDF is locked or damaged, so it cannot be marked with their name. Ask the firm to send it.',
    too_large_to_watermark:
      'This PDF is too large to send by secure link. Ask the firm to send it.',
    view_only_needs_preview:
      'This kind of file cannot be shown on the page: choose "View and download it".',
    file_not_found: 'That file is no longer on the portal. Reload the page.',
    client_links_off: 'The firm does not allow sending secure links from the portal.',
    download_limit: 'This file has been downloaded as many times as the link allows.',
    notice_not_sent: 'Your files were sent, but the email to the firm could not be sent.',
    cannot_notify: 'That person can no longer be told. Choose someone else.',
    share_revoked: 'This link has ended.',
    network: 'The portal cannot be reached right now. Try again later.',
  };
  return words[code] ?? 'Something went wrong. Try again.';
}

/** The `t` value from a link's #fragment (tokens stay out of server logs). */
export function tokenFromHash(hash: string): string {
  return new URLSearchParams(hash.replace(/^#/, '')).get('t') ?? '';
}
