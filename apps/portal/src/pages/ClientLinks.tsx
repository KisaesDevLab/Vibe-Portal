// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Sending a file the firm shared to someone outside, by a secure link (P55), when the firm
// allows it: the recipient gets an email with a private link and unlocks it with a code sent to
// that address. Always watermarked, at most 30 days. The firm sees every link and can end it.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Input } from '@vibe/ui';

import { api, say } from '../api';
import { usePages } from '../paging';

export interface ClientLink {
  id: string;
  email: string;
  name: string;
  organization: string;
  canDownload: boolean;
  createdAt: string;
  expiresAt: string;
  opens: number;
  status: 'locked' | 'revoked' | 'expired' | 'opened' | 'sent';
  files: string[];
}

const STATUS: Record<ClientLink['status'], string> = {
  sent: 'Sent, not opened yet',
  opened: 'Opened',
  expired: 'Expired',
  revoked: 'Ended',
  locked: 'Locked (too many wrong codes)',
};

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** Whether the firm allows client links, and this person's links. */
export function useClientLinks(clientId: string): {
  enabled: boolean;
  maxDays: number;
  links: ClientLink[];
  reload: () => void;
} {
  const [state, setState] = useState({ enabled: false, maxDays: 30, links: [] as ClientLink[] });
  const reload = useCallback(() => {
    api<{ enabled: boolean; maxDays: number; shares: ClientLink[] }>('/outside-shares')
      .then((r) => setState({ enabled: r.enabled, maxDays: r.maxDays, links: r.shares }))
      .catch(() => setState((s) => ({ ...s, enabled: false })));
  }, []);
  useEffect(reload, [reload, clientId]);
  return { ...state, reload };
}

/** The form for one file. */
export function SendLinkForm({
  clientId,
  file,
  maxDays,
  onSent,
  onCancel,
}: {
  clientId: string;
  file: { id: string; name: string; preview: boolean };
  maxDays: number;
  onSent: (note: string) => void;
  onCancel: () => void;
}): JSX.Element {
  // A file the page cannot show can only be downloaded.
  const [f, setF] = useState({
    email: '',
    name: '',
    organization: '',
    message: '',
    canDownload: !file.preview,
    days: Math.min(30, maxDays),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/outside-shares', {
        method: 'POST',
        body: { clientId, fileIds: [file.id], ...f },
      });
      onSent(`A secure link to ${file.name} was emailed to ${f.email}.`);
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      onSubmit={send}
      aria-label={`Send ${file.name} securely`}
      style={{
        display: 'grid',
        gap: 8,
        padding: 12,
        border: '1px solid var(--vibe-color-border)',
        borderRadius: 8,
      }}
    >
      <strong>Send “{file.name}” to someone outside</strong>
      <span style={{ fontSize: 13 }}>
        They get an email with a private link, and a code at that address to open it. Every page of
        a PDF carries their name and the date. The firm sees this link and can end it.
      </span>
      <Input
        label="Their email"
        name="linkEmail"
        type="email"
        required
        value={f.email}
        onChange={(e) => setF({ ...f, email: e.target.value })}
      />
      <Input
        label="Their name (optional)"
        name="linkName"
        value={f.name}
        onChange={(e) => setF({ ...f, name: e.target.value })}
      />
      <Input
        label="Their organization (optional, e.g. the bank)"
        name="linkOrg"
        value={f.organization}
        onChange={(e) => setF({ ...f, organization: e.target.value })}
      />
      <label style={{ display: 'grid', gap: 4 }}>
        <span>They may</span>
        <select
          value={f.canDownload ? 'download' : 'view'}
          disabled={!file.preview}
          onChange={(e) => setF({ ...f, canDownload: e.target.value === 'download' })}
        >
          {file.preview && <option value="view">View it only</option>}
          <option value="download">View and download it</option>
        </select>
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>The link works for</span>
        <select value={f.days} onChange={(e) => setF({ ...f, days: Number(e.target.value) })}>
          {[7, 14, 30]
            .filter((d) => d <= maxDays)
            .map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
        </select>
      </label>
      <label style={{ display: 'grid', gap: 4 }}>
        <span>Message (optional)</span>
        <textarea
          rows={2}
          maxLength={1000}
          value={f.message}
          onChange={(e) => setF({ ...f, message: e.target.value })}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="submit" disabled={busy || !f.email.trim()}>
          Send secure link
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** The links this person sent, with Stop. */
export function ClientLinksList({
  links,
  onChanged,
}: {
  links: ClientLink[];
  onChanged: () => void;
}): JSX.Element | null {
  const [error, setError] = useState('');
  const { slice, pager } = usePages(links);
  if (links.length === 0) return null;
  async function stop(l: ClientLink): Promise<void> {
    if (!window.confirm(`End the link sent to ${l.email}? It stops working at once.`)) return;
    setError('');
    try {
      await api(`/outside-shares/${l.id}`, { method: 'DELETE' });
    } catch (err) {
      setError(say(err));
    }
    onChanged();
  }
  return (
    <section aria-label="Links you sent" style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Links you sent</h2>
      {error && <p role="alert">{error}</p>}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
        {slice.map((l) => (
          <li
            key={l.id}
            style={{
              display: 'flex',
              gap: 12,
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              padding: '8px 0',
              borderBottom: '1px solid var(--vibe-border, #ddd)',
            }}
          >
            <div>
              <strong>{l.files.join(', ')}</strong> to {l.name ? `${l.name} ` : ''}
              {l.organization ? `(${l.organization}) ` : ''}
              {l.email}
              <br />
              <small>
                {STATUS[l.status]}
                {l.status === 'opened' || l.status === 'sent'
                  ? ` · works until ${day(l.expiresAt)}`
                  : ''}
                {l.canDownload ? ' · view and download' : ' · view only'}
              </small>
            </div>
            {(l.status === 'sent' || l.status === 'opened') && (
              <Button size="sm" variant="secondary" onClick={() => void stop(l)}>
                End link
              </Button>
            )}
          </li>
        ))}
      </ul>
      {pager}
    </section>
  );
}
