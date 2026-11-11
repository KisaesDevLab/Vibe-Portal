// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Where the link to confirm a new email or mobile number lands (P66): /auth/confirm-contact#t=...
// The firm's staff asked for the change; opening this link proves the person gets messages
// there. As with sign-in links (QA 2026-11-09) nothing happens until the button is pressed, so a
// mail scanner opening the link does not use it up.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@vibe/ui';

import { FirmAuthLayout } from '../branding';
import { api, ApiError, say, tokenFromHash } from '../api';

export function ConfirmContact(): JSX.Element {
  const token = useRef(tokenFromHash(window.location.hash));
  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const [error, setError] = useState(token.current ? '' : 'missing');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'email' | 'phone' | null>(null);

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      const r = await api<{ field: 'email' | 'phone' }>('/auth/confirm-contact', {
        body: { token: token.current },
      });
      setDone(r.field);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(
        code === 'link_expired'
          ? 'This link has expired or was already used. Ask your accountant to send it again.'
          : code === 'contact_taken'
            ? 'Someone else already signs in with this email address or number. Ask your accountant.'
            : say(err),
      );
      setBusy(false);
    }
  }

  if (done) {
    return (
      <FirmAuthLayout brand="Client portal" title="Confirmed">
        <p role="status">
          {done === 'email'
            ? 'This email address is now the one you sign in with.'
            : 'This mobile number is now the one you sign in with.'}
        </p>
        <Link to="/login">Sign in</Link>
      </FirmAuthLayout>
    );
  }

  if (error) {
    return (
      <FirmAuthLayout brand="Client portal" title="Link not valid">
        <p role="alert">
          {error === 'missing'
            ? 'This link is not complete. Ask your accountant to send it again.'
            : error}
        </p>
        <Link to="/login">Sign in</Link>
      </FirmAuthLayout>
    );
  }

  return (
    <FirmAuthLayout brand="Client portal" title="Confirm your sign-in details">
      <div style={{ display: 'grid', gap: 12 }}>
        <p>
          Your accountant asked to use this email address or mobile number for signing in to their
          client portal. If that is right, confirm it.
        </p>
        <Button onClick={() => void confirm()} disabled={busy}>
          Confirm
        </Button>
      </div>
    </FirmAuthLayout>
  );
}
