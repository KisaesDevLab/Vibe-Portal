// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Signed-in home: which client, its files, sign out, and signing in by text (P50). Laid out
// as a top bar and cards on a tinted page (owner 2026-11-11: modern look, readability).

import { Reveal } from '../components/Reveal';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Button, ThemeToggle } from '@vibe/ui';

import { Select } from '../components/Field';
import { ClientLinkBanner } from '../components/ClientBanner';
import { Section } from '../components/FileKind';
import { FirmLogo } from '../branding';
import { api, ApiError, say, type Me } from '../api';
import { ClientLinksList, SendLinkForm, useClientLinks } from './ClientLinks';
import { Files, type PortalFile } from './Files';
import { PhoneSignIn, type Pending } from './PhoneSignIn';
import { Uploads } from './Uploads';

type State = 'loading' | 'ready' | 'signed_out' | 'error';

export function Home(): JSX.Element {
  const navigate = useNavigate();
  // A code texted when the invitation was accepted with "also sign in by text", or why none
  // was. Kept here and cleared from the history entry, so a reload does not bring it back.
  const location = useLocation();
  const [handoff] = useState(
    () => location.state as { phoneCode?: Pending; phoneProblem?: string } | null,
  );
  const pending = handoff?.phoneCode ?? null;
  // P55: a file being sent to someone outside, and what was last sent.
  const [sending, setSending] = useState<PortalFile | null>(null);
  const [sentNote, setSentNote] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const links = useClientLinks(me?.activeClientId ?? '');
  // A form for one client's file never stays open on another client's page.
  const shownClient = me?.activeClientId;
  useEffect(() => {
    setSending(null);
    setSentNote('');
  }, [shownClient]);
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fileCount, setFileCount] = useState<number | undefined>(undefined);
  // P76: the active client's link from another service, at the top of the page.
  const [clientLink, setClientLink] = useState<{
    url: string;
    message: string;
    button: string;
  } | null>(null);
  useEffect(() => {
    setClientLink(null);
    setFileCount(undefined);
    if (!shownClient) return;
    let current = true;
    api<{ link: { url: string; message: string; button: string } | null }>('/client-link')
      .then((r) => current && setClientLink(r.link))
      .catch(() => current && setClientLink(null));
    return () => {
      current = false;
    };
  }, [shownClient]);

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

  useEffect(() => {
    if (!handoff) return;
    if (handoff.phoneProblem) {
      setNotice(
        `${say(new ApiError(0, handoff.phoneProblem))} You can add your mobile number below.`,
      );
    }
    navigate(location.pathname, { replace: true, state: null });
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state === 'signed_out') return <Navigate to="/login" replace />;
  if (state === 'loading') return <p role="status">Loading…</p>;
  if (state === 'error' || !me) {
    return (
      <main id="main-content" tabIndex={-1} className="p-page">
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

  document.title = `Your files · ${me.firmName}`;
  const who = me.identity.name || me.identity.email || me.identity.phone;
  return (
    <>
      <header className="p-topbar">
        <div className="p-topbar-inner">
          <div className="p-brand">
            <FirmLogo height={36} />
            <span>{me.firmName}</span>
          </div>
          <div className="p-account">
            {/* Light or dark, remembered in this browser (the device's setting until chosen). */}
            <ThemeToggle />
            <Button variant="secondary" size="sm" onClick={() => void signOut()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="p-page">
        <div className="p-intro">
          <div style={{ minWidth: 0 }}>
            <h1>{active?.name ?? me.firmName}</h1>
            <p className="p-sub" style={{ overflowWrap: 'anywhere' }}>
              Signed in as {who}.
            </p>
          </div>
          {me.clients.length > 1 && (
            <div className="p-switch">
              <Select
                label="Showing files for"
                value={me.activeClientId}
                onChange={(e) => void switchTo(e.target.value)}
              >
                {me.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
        {notice && <p role="alert">{notice}</p>}
        {clientLink && <ClientLinkBanner link={clientLink} />}
        <Section
          id="files-heading"
          title="Files from the firm"
          count={fileCount}
          sub={`Shared with you by ${me.firmName}. PDFs and pictures open here; everything downloads.`}
        >
          {sentNote && (
            <p role="status" style={{ overflowWrap: 'anywhere' }}>
              {sentNote}
            </p>
          )}
          {sending && (
            <Reveal>
              <SendLinkForm
                key={sending.id}
                clientId={me.activeClientId}
                file={{ id: sending.id, name: sending.name, preview: sending.preview !== null }}
                maxDays={links.maxDays}
                onSent={(note) => {
                  setSending(null);
                  setSentNote(note);
                  links.reload();
                }}
                onCancel={() => setSending(null)}
              />
            </Reveal>
          )}
          <Files
            clientId={me.activeClientId}
            onCount={setFileCount}
            {...(links.enabled
              ? {
                  onSend: (f: PortalFile) => {
                    setSentNote('');
                    setSending(f);
                  },
                }
              : {})}
          />
        </Section>
        <ClientLinksList links={links.links} onChanged={links.reload} />
        <Uploads clientId={me.activeClientId} />
        <PhoneSignIn
          me={me}
          pending={pending}
          onChange={(phone) => setMe((m) => (m ? { ...m, identity: { ...m.identity, phone } } : m))}
        />
      </main>
    </>
  );
}
