// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Signed-in home: which client, its files, sign out, and signing in by text (P50).

import { useCallback, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button, Card } from '@vibe/ui';

import { api, ApiError, say, type Me } from '../api';
import { Files } from './Files';
import { PhoneSignIn, type Pending } from './PhoneSignIn';
import { Uploads } from './Uploads';

type State = 'loading' | 'ready' | 'signed_out' | 'error';

export function Home(): JSX.Element {
  const navigate = useNavigate();
  // A code texted when the invitation was accepted with "also sign in by text".
  const pending = (useLocation().state as { phoneCode?: Pending } | null)?.phoneCode ?? null;
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  /** A failed call: signed out -> sign in; anything else -> a message. */
  const fail = useCallback((err: unknown, whole: boolean) => {
    if (err instanceof ApiError && err.status === 401) setState('signed_out');
    else if (whole) {
      setError(say(err));
      setState('error');
    } else setNotice(say(err));
  }, []);

  const load = useCallback(() => {
    setState('loading');
    api<Me>('/auth/me')
      .then((m) => {
        setMe(m);
        setState('ready');
      })
      .catch((err: unknown) => fail(err, true));
  }, [fail]);

  useEffect(load, [load]);

  if (state === 'signed_out') return <Navigate to="/login" replace />;
  if (state === 'loading') return <p role="status">Loading…</p>;
  if (state === 'error' || !me) {
    return (
      <main style={{ maxWidth: 760, margin: '0 auto', padding: 16, display: 'grid', gap: 12 }}>
        <p role="alert">{error}</p>
        <Button onClick={load}>Try again</Button>
      </main>
    );
  }

  const active = me.clients.find((c) => c.id === me.activeClientId);

  async function switchTo(clientId: string): Promise<void> {
    setNotice('');
    try {
      await api('/auth/switch-client', { body: { clientId } });
      setMe((m) => (m ? { ...m, activeClientId: clientId } : m));
    } catch (err) {
      fail(err, false);
    }
  }

  async function signOut(): Promise<void> {
    setNotice('');
    try {
      await api('/auth/logout', { method: 'POST' });
      navigate('/login', { replace: true });
    } catch (err) {
      fail(err, false);
    }
  }

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 16, display: 'grid', gap: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>{me.firmName}</h1>
        <Button variant="secondary" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>
      {notice && <p role="alert">{notice}</p>}
      <Card title={active?.name ?? ''}>
        <p>Signed in as {me.identity.name || me.identity.email || me.identity.phone}.</p>
        {me.clients.length > 1 && (
          <label style={{ display: 'grid', gap: 4, maxWidth: 320 }}>
            <span>Showing files for</span>
            <select value={me.activeClientId} onChange={(e) => void switchTo(e.target.value)}>
              {me.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <Files clientId={me.activeClientId} />
      </Card>
      <Card>
        <Uploads clientId={me.activeClientId} />
      </Card>
      <Card>
        <PhoneSignIn
          me={me}
          pending={pending}
          onChange={(phone) => setMe((m) => (m ? { ...m, identity: { ...m.identity, phone } } : m))}
        />
      </Card>
    </main>
  );
}
