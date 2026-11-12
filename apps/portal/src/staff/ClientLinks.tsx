// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P76: each client's link from another service, shown at the top of the client's portal with a
// short message and a button. Set on a client's page, or many at once from a CSV on Clients;
// any staff member, for the clients they see. A CSV is checked first (what each row would do)
// and changes nothing until Apply.

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Card, Input } from '@vibe/ui';

import { ApiError } from '../api';
import { Badge } from '../components/FileKind';
import { Reveal } from '../components/Reveal';
import { staffApi, staffSay } from './api';

export interface ClientLinkValue {
  url: string;
  message: string;
  button: string;
}

interface ListedLink extends ClientLinkValue {
  clientId: string;
  clientCode: string;
  client: string;
  updatedAt: string;
  updatedBy: string;
}

type RowStatus =
  | 'new'
  | 'changed'
  | 'unchanged'
  | 'removed'
  | 'no_link'
  | 'not_found'
  | 'ambiguous'
  | 'duplicate'
  | 'invalid';

interface RowResult {
  line: number;
  status: RowStatus;
  client?: string;
  clientCode?: string;
  asked?: string;
  reason?: string;
}

const STATUS: Record<
  RowStatus,
  { text: string; tone: 'neutral' | 'accent' | 'success' | 'warning' }
> = {
  new: { text: 'New link', tone: 'success' },
  changed: { text: 'Replaces the link', tone: 'accent' },
  unchanged: { text: 'No change', tone: 'neutral' },
  removed: { text: 'Removes the link', tone: 'warning' },
  no_link: { text: 'No URL, no link', tone: 'neutral' },
  not_found: { text: 'No such client', tone: 'warning' },
  ambiguous: { text: 'More than one client', tone: 'warning' },
  duplicate: { text: 'Client already in the file', tone: 'warning' },
  invalid: { text: 'Not taken', tone: 'warning' },
};

const REASON: Record<string, string> = {
  invalid_url: 'the URL must start with https:// or http://',
  invalid_message: 'a message is needed (300 characters at most)',
  invalid_button: 'the button text is 40 characters at most',
};

/** A field for a CSV file: quotes round any value with a comma, quote or line break; a value
 *  a spreadsheet would run as a formula (=, +, -, @) starts with ' (the import drops it). */
const cell = (raw: string): string => {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

/** How the link looks on the client's portal (the same as the home page's banner). */
export function LinkPreview({ link }: { link: ClientLinkValue }): JSX.Element {
  return (
    <div className="p-banner" aria-label="How it looks on the portal" role="group">
      <p className="p-banner-text">{link.message || 'Your message'}</p>
      <span className="p-banner-button" aria-hidden="true">
        {link.button || 'Open'}
      </span>
    </div>
  );
}

/** A client's link, on its page. */
export function ClientPortalLink({
  clientId,
  onChanged,
}: {
  clientId: string;
  onChanged: () => void;
}): JSX.Element {
  const [link, setLink] = useState<ClientLinkValue | null | undefined>(undefined);
  const [form, setForm] = useState<ClientLinkValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = useCallback(() => {
    staffApi<{ link: ClientLinkValue | null }>(`/v1/clients/${clientId}/link`)
      .then((r) => setLink(r.link))
      .catch((err: unknown) => setError(staffSay(err)));
  }, [clientId]);
  useEffect(load, [load]);

  const run = async (f: () => Promise<void>, note: string): Promise<void> => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await f();
      setDone(note);
      load();
      onChanged();
    } catch (err) {
      setError(staffSay(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent): void => {
    e.preventDefault();
    if (!form) return;
    void run(async () => {
      await staffApi(`/v1/clients/${clientId}/link`, { method: 'PUT', body: form });
      setForm(null);
    }, 'Saved. The client sees it the next time their portal page loads.');
  };

  const remove = (): void => {
    if (!window.confirm('Remove this link from the client’s portal?')) return;
    void run(async () => {
      await staffApi(`/v1/clients/${clientId}/link`, { method: 'DELETE' });
    }, 'Removed.');
  };

  return (
    <Card title="Link on the portal">
      <div style={{ display: 'grid', gap: 12 }}>
        <p style={{ margin: 0 }}>
          A short message and a button at the top of this client’s portal, opening their own link
          (for example, to pay an invoice or book a meeting).
        </p>
        {link === undefined && !error && <p role="status">Loading…</p>}
        {link === null && !form && <p style={{ margin: 0 }}>No link yet.</p>}
        {link && !form && (
          <>
            <LinkPreview link={link} />
            <p style={{ margin: 0, overflowWrap: 'anywhere', fontSize: 14 }}>
              Opens{' '}
              {/^https?:\/\//i.test(link.url) ? (
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.url}
                </a>
              ) : (
                link.url
              )}
            </p>
          </>
        )}
        {form && (
          <Reveal>
            <form onSubmit={save} style={{ display: 'grid', gap: 12, maxWidth: 560 }}>
              <Input
                label="Message"
                name="message"
                maxLength={300}
                value={form.message}
                onChange={(e) => setForm({ ...form, message: e.target.value })}
                placeholder="Your invoice is ready."
              />
              <Input
                label="Button text"
                name="button"
                maxLength={40}
                value={form.button}
                hint="Open, if left empty."
                onChange={(e) => setForm({ ...form, button: e.target.value })}
                placeholder="Pay now"
              />
              <Input
                label="URL"
                name="url"
                type="url"
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                maxLength={2000}
                value={form.url}
                hint="This client’s own link, starting with https://"
                onChange={(e) => setForm({ ...form, url: e.target.value })}
              />
              <LinkPreview link={form} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button type="submit" disabled={busy || !form.url.trim() || !form.message.trim()}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setForm(null);
                    setError('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Reveal>
        )}
        {error && <p role="alert">{error}</p>}
        {done && <p role="status">{done}</p>}
        {!form && link !== undefined && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              onClick={() => {
                setDone('');
                setForm(link ? { ...link } : { url: '', message: '', button: '' });
              }}
            >
              {link ? 'Change' : 'Add a link'}
            </Button>
            {link && (
              <Button variant="secondary" disabled={busy} onClick={remove}>
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Links for many clients from a CSV, on the Clients page. */
export function ClientLinksImport({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [rows, setRows] = useState<RowResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const check = async (text: string, apply: boolean): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      const r = await staffApi<{ rows: RowResult[]; changes: number }>('/v1/client-links/import', {
        body: { csv: text, apply },
      });
      if (apply) {
        setDone(
          r.changes === 0
            ? 'Nothing to change.'
            : `Done: ${r.changes} ${r.changes === 1 ? 'client' : 'clients'} changed.`,
        );
        setCsv(null);
        setRows(null);
        setOpen(false);
        onChanged();
      } else setRows(r.rows);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'csv_columns'
          ? 'The file needs a header row with a URL column and a client code or client name column.'
          : staffSay(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const download = async (): Promise<void> => {
    setError('');
    try {
      const r = await staffApi<{ links: ListedLink[] }>('/v1/client-links');
      const lines = [
        'client_code,client_name,url,message,button',
        ...r.links.map((l) =>
          [l.clientCode, l.client, l.url, l.message, l.button].map(cell).join(','),
        ),
      ];
      // The byte-order mark tells Excel the file is UTF-8 (names with accents).
      const blob = new Blob([`\uFEFF${lines.join('\r\n')}\r\n`], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'client-links.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (err) {
      setError(staffSay(err));
    }
  };

  const changes = rows?.filter((r) => ['new', 'changed', 'removed'].includes(r.status)).length ?? 0;
  const problems = rows?.filter(
    (r) => STATUS[r.status].tone === 'warning' && r.status !== 'removed',
  );

  if (!open) {
    return (
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="secondary"
          onClick={() => {
            setDone('');
            setOpen(true);
          }}
        >
          Portal links from a CSV…
        </Button>
        {done && (
          <p role="status" style={{ margin: 0, alignSelf: 'center' }}>
            {done}
          </p>
        )}
      </div>
    );
  }
  return (
    <Reveal>
      <section
        aria-labelledby="links-csv-heading"
        style={{
          display: 'grid',
          gap: 12,
          padding: 16,
          border: '1px solid var(--vibe-color-border)',
          borderRadius: 12,
        }}
      >
        <h3 id="links-csv-heading" style={{ margin: 0, fontSize: 16 }}>
          Portal links from a CSV
        </h3>
        <p style={{ margin: 0 }}>
          One row per client, with a header row: <code>client_code</code> or{' '}
          <code>client_name</code> (or both), <code>url</code>, <code>message</code> and{' '}
          <code>button</code> (optional, Open if empty). A row replaces the client’s link; a row
          with no URL removes it. Rows are matched by client code first, then by name.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 500 }}>
            CSV file
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                setRows(null);
                setDone('');
                setError('');
                if (!f) return setCsv(null);
                if (f.size > 2_000_000) {
                  setCsv(null);
                  setError('That file is too large (2 MB at most).');
                  return;
                }
                void f.text().then((text) => {
                  if (text.length > 2_100_000) {
                    setError('That file is too large (2 MB at most).');
                    return;
                  }
                  setCsv({ name: f.name, text });
                  void check(text, false);
                });
              }}
            />
          </label>
          <Button variant="secondary" size="sm" onClick={() => void download()}>
            Download the current links
          </Button>
        </div>
        {busy && <p role="status">Checking…</p>}
        {error && <p role="alert">{error}</p>}
        {rows && (
          <>
            <p role="status" style={{ margin: 0 }}>
              {rows.length} {rows.length === 1 ? 'row' : 'rows'}: {changes}{' '}
              {changes === 1 ? 'change' : 'changes'}
              {problems && problems.length > 0 ? `, ${problems.length} not taken (below)` : ''}.
              Nothing has changed yet.
            </p>
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                <thead>
                  <tr>
                    {['Row', 'Client', 'What happens'].map((h) => (
                      <th key={h} style={{ textAlign: 'left', padding: '6px 8px' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.line} style={{ borderTop: '1px solid var(--vibe-color-border)' }}>
                      <td style={{ padding: '6px 8px' }}>{r.line}</td>
                      <td style={{ padding: '6px 8px', overflowWrap: 'anywhere' }}>
                        {r.client ?? r.asked ?? ''}
                        {r.clientCode ? ` (${r.clientCode})` : ''}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].text}</Badge>
                        {r.reason ? ` ${REASON[r.reason] ?? r.reason}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            disabled={busy || !csv || !rows || changes === 0}
            onClick={() => csv && void check(csv.text, true)}
          >
            {busy && rows
              ? 'Applying…'
              : changes > 0
                ? `Apply ${changes} ${changes === 1 ? 'change' : 'changes'}`
                : 'Apply'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(false);
              setCsv(null);
              setRows(null);
              setError('');
            }}
          >
            Close
          </Button>
        </div>
      </section>
    </Reveal>
  );
}
