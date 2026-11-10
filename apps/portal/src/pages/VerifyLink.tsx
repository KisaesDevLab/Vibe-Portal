// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Where a sign-in link lands: /auth/verify#t=...

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthLayout } from '@vibe/ui';

import { api, say, tokenFromHash } from '../api';

export function VerifyLink(): JSX.Element {
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const tried = useRef(false);

  useEffect(() => {
    if (tried.current) return;
    tried.current = true;
    const token = tokenFromHash(window.location.hash);
    // Take the token out of the address bar and history.
    window.history.replaceState(null, '', window.location.pathname);
    api('/auth/verify-link', { body: { token } })
      .then(() => navigate('/', { replace: true }))
      .catch((err: unknown) => setError(say(err)));
  }, [navigate]);

  return (
    <AuthLayout brand="Client Portal" title={error ? 'Sign-in link not valid' : 'Signing you in…'}>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <Link to="/login">Sign in again</Link>
        </>
      ) : (
        <p role="status">One moment.</p>
      )}
    </AuthLayout>
  );
}
