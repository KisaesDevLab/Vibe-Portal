// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Where a secure link sent to someone outside the client lands (P49): /shared#t=<id>.<secret>.
// No account: the link, then a one-time code emailed to the address the firm sent it to. The
// page shows nothing about the documents until that code is given.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AuthLayout, Button, Input } from '@vibe/ui';

import { api, ApiError, say, tokenFromHash } from '../api';
import { ProtectedPdfViewer } from '../components/ProtectedPdfViewer';
import { sizeText } from './Files';

interface OutsideFile {
  id: string;
  name: string;
  size: number;
  preview: 'pdf' | 'image' | null;
}

interface Info {
  firmName: string;
  emailMasked: string;
  expiresAt: string;
  canDownload: boolean;
  count: number;
  verified: boolean;
  recipientName?: string;
  organization?: string;
  verifiedUntil?: string;
  files?: OutsideFile[];
}

type Ended = 'unavailable' | 'expired' | 'revoked' | 'locked';

const ENDED: Record<Ended, { title: string; text: string }> = {
  unavailable: {
    title: 'Link unavailable',
    text: 'This link is not valid. Open the link in the email again, or ask the firm that sent it for a new one.',
  },
  expired: {
    title: 'Link expired',
    text: 'This link has expired. Ask the firm that sent it for a new one.',
  },
  revoked: {
    title: 'Link revoked',
    text: 'The firm has ended this link. Ask them for a new one if you still need the documents.',
  },
  locked: {
    title: 'Access locked',
    text: 'Too many wrong codes were entered, so this link was ended. Ask the firm that sent it for a new one.',
  },
};

const RECHECK_MS = 20_000;

/** The link's token survives a reload of this tab, and stays out of the address bar. */
const KEPT = 'vibe-shared-link';

function readToken(): string {
  const fromLink = tokenFromHash(window.location.hash);
  try {
    if (fromLink) window.sessionStorage.setItem(KEPT, fromLink);
    return fromLink || (window.sessionStorage.getItem(KEPT) ?? '');
  } catch {
    return fromLink;
  }
}

function endedBy(err: unknown): Ended | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'share_expired') return 'expired';
  if (err.code === 'share_revoked') return 'revoked';
  if (err.code === 'share_locked') return 'locked';
  return err.status === 404 ? 'unavailable' : null;
}

const timeText = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

const dayText = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });

export function Shared(): JSX.Element {
  const token = useRef(readToken());
  const id = token.current.slice(0, 36);
  const key = token.current.charAt(36) === '.' ? token.current.slice(37) : '';
  const [info, setInfo] = useState<Info | null>(null);
  const [ended, setEnded] = useState<Ended | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [viewing, setViewing] = useState<string | null>(null);

  const failed = useCallback((err: unknown): void => {
    const end = endedBy(err);
    if (end) setEnded(end);
    else setError(say(err));
  }, []);

  /** Reads what the link shows now: the documents while verified, else the code step. */
  const open = useCallback(
    async (locked = false): Promise<void> => {
      try {
        const next = await api<Info>(`/shared/${id}/open`, { body: { key } });
        setInfo(next);
        if (!next.verified) {
          setViewing(null);
          setSent(false);
          setCode('');
          if (locked) setNote('For your security this page locked. Send a new code to continue.');
        }
      } catch (err) {
        failed(err);
      }
    },
    [id, key, failed],
  );

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    if (!key) {
      setEnded('unavailable');
      return;
    }
    void open();
  }, [key, open]);

  // The verified half hour: when it is over, the page goes back to the code step by itself.
  // The server decides when that is. Should this device's clock run ahead of it, the page asks
  // again a little later instead of over and over.
  useEffect(() => {
    if (!info?.verified || !info.verifiedUntil) return undefined;
    const left = new Date(info.verifiedUntil).getTime() - Date.now();
    const timer = window.setTimeout(() => void open(true), left > 0 ? left + 500 : RECHECK_MS);
    return () => window.clearTimeout(timer);
  }, [info, open]);

  // One document that the page can show opens by itself.
  const files = info?.files;
  useEffect(() => {
    const only = files?.length === 1 ? files[0] : undefined;
    if (only?.preview) setViewing(only.id);
  }, [files]);

  async function sendCode(): Promise<void> {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await api(`/shared/${id}/code`, { body: { key } });
      setSent(true);
      setCode('');
      setNote(`We sent a code to ${info?.emailMasked ?? 'your email'}. It lasts 10 minutes.`);
    } catch (err) {
      // A code sent a moment ago is still good: let them type it.
      if (err instanceof ApiError && err.code === 'code_wait') setSent(true);
      failed(err);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNote('');
    try {
      setInfo(await api<Info>(`/shared/${id}/verify`, { body: { key, code: code.trim() } }));
    } catch (err) {
      setCode('');
      failed(err);
    } finally {
      setBusy(false);
    }
  }

  if (ended) {
    return (
      <AuthLayout brand={info?.firmName ?? 'Secure documents'} title={ENDED[ended].title}>
        <p role="alert">{ENDED[ended].text}</p>
      </AuthLayout>
    );
  }

  if (!info) {
    return (
      <AuthLayout brand="Secure documents" title={error ? 'Link not opened' : 'Opening…'}>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <Button
              onClick={() => {
                setError('');
                void open();
              }}
            >
              Try again
            </Button>
          </>
        ) : (
          <p role="status">One moment.</p>
        )}
      </AuthLayout>
    );
  }

  if (!info.verified) {
    const what = info.count === 1 ? 'a document' : `${info.count} documents`;
    return (
      <AuthLayout
        brand={info.firmName}
        title="Secure documents"
        footer={<span>This link expires {dayText(info.expiresAt)}.</span>}
      >
        {info.count === 0 ? (
          <p role="alert">
            {info.firmName} has taken down the documents in this link. Ask them to send it again.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            <p style={{ margin: 0 }}>
              {info.firmName} shared {what} with you. To open {info.count === 1 ? 'it' : 'them'},
              enter a one-time access code that we email to <strong>{info.emailMasked}</strong>.
            </p>
            {note && <p role="status">{note}</p>}
            {error && <p role="alert">{error}</p>}
            {!sent ? (
              <Button disabled={busy} onClick={() => void sendCode()}>
                Send access code
              </Button>
            ) : (
              <form onSubmit={verify} style={{ display: 'grid', gap: 12 }}>
                <Input
                  label="Access code"
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
                <Button type="submit" disabled={busy || code.length !== 6}>
                  Verify code
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void sendCode()}
                >
                  Send a new code
                </Button>
              </form>
            )}
          </div>
        )}
      </AuthLayout>
    );
  }

  const list = info.files ?? [];
  const shown = list.find((f) => f.id === viewing);
  const url = (f: OutsideFile, mode: 'view' | 'download'): string =>
    `/api/portal/shared/${id}/files/${f.id}/content?mode=${mode}`;
  const who = [info.recipientName, info.organization].filter(Boolean).join(', ');

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: 16, display: 'grid', gap: 12 }}>
      <header>
        <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          {info.firmName}
        </div>
        <h1 style={{ fontSize: 20, margin: '4px 0' }}>Shared documents ({list.length})</h1>
        <p style={{ margin: 0, fontSize: 13 }}>
          {who ? `Shared with ${who}. ` : ''}
          {info.canDownload
            ? 'You can view and download these documents.'
            : 'These documents are shared to view only.'}{' '}
          For your security this page locks at {timeText(info.verifiedUntil ?? '')}; the link itself
          works until {dayText(info.expiresAt)}.
        </p>
      </header>
      {error && <p role="alert">{error}</p>}
      {list.length === 0 && (
        <p role="status">{info.firmName} has taken down the documents in this link.</p>
      )}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {list.map((f) => (
          <li
            key={f.id}
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}
          >
            <span style={{ overflowWrap: 'anywhere', flex: '1 1 200px' }}>
              {f.name} · {sizeText(f.size)}
            </span>
            {f.preview && (
              <Button
                size="sm"
                variant={viewing === f.id ? 'primary' : 'secondary'}
                aria-label={`View ${f.name}`}
                aria-pressed={viewing === f.id}
                onClick={() => setViewing(f.id)}
              >
                View
              </Button>
            )}
            {info.canDownload && (
              <a href={url(f, 'download')} download={f.name} aria-label={`Download ${f.name}`}>
                Download
              </a>
            )}
          </li>
        ))}
      </ul>
      {shown?.preview === 'pdf' && (
        <ProtectedPdfViewer
          key={shown.id}
          url={url(shown, 'view')}
          downloadUrl={url(shown, 'download')}
          canDownload={info.canDownload}
          filename={shown.name}
        />
      )}
      {shown?.preview === 'image' && (
        <img
          src={url(shown, 'view')}
          alt={shown.name}
          draggable={info.canDownload}
          onContextMenu={(e) => {
            if (!info.canDownload) e.preventDefault();
          }}
          style={{ maxWidth: '100%', height: 'auto' }}
        />
      )}
    </main>
  );
}
