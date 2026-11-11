// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Where a sign-in link lands: /auth/verify#t=...
//
// QA 2026-11-09: the link is used only when the person presses "Sign in". Email security
// scanners open links (some run the page's script); an automatic sign-in would use the one-time
// link up before the client gets to it.

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@vibe/ui';

import { FirmAuthLayout } from '../branding';
import { api, say, tokenFromHash } from '../api';

export function VerifyLink(): JSX.Element {
  const navigate = useNavigate();
  const token = useRef(tokenFromHash(window.location.hash));
  useEffect(() => {
    // Take the token out of the address bar and history.
    window.history.replaceState(null, '', window.location.pathname);
  }, []);
  const [error, setError] = useState(token.current ? '' : 'missing');
  const [busy, setBusy] = useState(false);

  async function signIn(): Promise<void> {
    setBusy(true);
    try {
      await api('/auth/verify-link', { body: { token: token.current } });
      navigate('/', { replace: true });
    } catch (err) {
      setError(say(err));
      setBusy(false);
    }
  }

  if (error) {
    return (
      <FirmAuthLayout brand="Client portal" title="Sign-in link not valid">
        <p role="alert">
          {error === 'missing' ? 'This sign-in link is not complete. Ask for a new one.' : error}
        </p>
        <Link to="/login">Sign in again</Link>
      </FirmAuthLayout>
    );
  }

  return (
    <FirmAuthLayout brand="Client portal" title="Sign in">
      <div style={{ display: 'grid', gap: 12 }}>
        <p>Press the button to finish signing in.</p>
        <Button onClick={() => void signIn()} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </div>
    </FirmAuthLayout>
  );
}
