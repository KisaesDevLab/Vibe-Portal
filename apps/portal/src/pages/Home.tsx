// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Signed-in home. Files arrive in Phase 3; for now: who is signed in, which client, sign out.

import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Card } from '@vibe/ui';

import { api, ApiError, say, type Me } from '../api';

export function Home(): JSX.Element {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'signed_out' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    api<Me>('/auth/me')
      .then((m) => {
        setMe(m);
        setState('ready');
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setState('signed_out');
        else {
          setError(say(err));
          setState('error');
        }
      });
  }, []);

  if (state === 'signed_out') return <Navigate to="/login" replace />;
  if (state === 'loading') return <p role="status">Loading…</p>;
  if (state === 'error' || !me) return <p role="alert">{error}</p>;

  const active = me.clients.find((c) => c.id === me.activeClientId);

  async function switchTo(clientId: string): Promise<void> {
    await api('/auth/switch-client', { body: { clientId } });
    setMe((m) => (m ? { ...m, activeClientId: clientId } : m));
  }

  async function signOut(): Promise<void> {
    await api('/auth/logout', { method: 'POST' });
    navigate('/login', { replace: true });
  }

  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 16, display: 'grid', gap: 16 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>{me.firmName}</h1>
        <Button variant="secondary" size="sm" onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>
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
        <p>Files the firm shares with you will appear here.</p>
      </Card>
    </main>
  );
}
