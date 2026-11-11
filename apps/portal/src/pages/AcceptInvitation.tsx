// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Where an invitation link lands: /invite#t=...

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input } from '@vibe/ui';

import { FirmAuthLayout } from '../branding';
import { api, say, tokenFromHash } from '../api';
import { KeepSignedIn } from './KeepSignedIn';

interface Preview {
  firmName: string;
  clientName: string;
  name: string;
  contact: string;
  /** A mobile number staff gave beside the email, masked, offered for signing in by text. */
  alsoPhone?: string | null;
}

export function AcceptInvitation(): JSX.Element {
  const navigate = useNavigate();
  const token = useRef(tokenFromHash(window.location.hash));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState('');
  const [keep, setKeep] = useState(false);
  const [addPhone, setAddPhone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
    api<Preview>('/invitations/preview', { body: { token: token.current } })
      .then((p) => {
        setPreview(p);
        setName(p.name);
      })
      .catch((err: unknown) => setError(say(err)));
  }, []);

  async function accept(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ phoneCode?: string; phone?: string }>('/invitations/accept', {
        body: {
          token: token.current,
          name: name.trim(),
          keepSignedIn: keep,
          addPhone: addPhone && Boolean(preview?.alsoPhone),
        },
      });
      // A code texted to the number waits on the home page; any other answer (too many codes)
      // is said there, where the person can add the number.
      navigate('/', {
        replace: true,
        state:
          r.phoneCode === 'sent' && r.phone
            ? { phoneCode: { phone: r.phone } }
            : r.phoneCode
              ? { phoneProblem: r.phoneCode }
              : null,
      });
    } catch (err) {
      setError(say(err));
      setBusy(false);
    }
  }

  if (!preview) {
    return (
      <FirmAuthLayout
        brand="Client portal"
        title={error ? 'Invitation not valid' : 'Opening your invitation…'}
      >
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Link to="/login">Sign in</Link>
          </>
        ) : (
          <p role="status">One moment.</p>
        )}
      </FirmAuthLayout>
    );
  }

  return (
    <FirmAuthLayout brand={preview.firmName} title="Accept your invitation">
      <form onSubmit={accept} style={{ display: 'grid', gap: 12 }}>
        <p>
          {preview.firmName} invites you to its client portal for{' '}
          <strong>{preview.clientName}</strong>. You will sign in with {preview.contact}.
        </p>
        <Input
          label="Your name"
          name="name"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {preview.alsoPhone && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={addPhone}
              onChange={(e) => setAddPhone(e.target.checked)}
            />
            <span>
              Also let me sign in by text at {preview.alsoPhone}
              <br />
              <small>A code is texted to that number to confirm it is yours.</small>
            </span>
          </label>
        )}
        <KeepSignedIn checked={keep} onChange={setKeep} />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Accept and sign in'}
        </Button>
      </form>
    </FirmAuthLayout>
  );
}
