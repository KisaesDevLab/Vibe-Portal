// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The staff page (D13): clients and their people and files, access requests, client uploads,
// the history, and Settings (P36). Sharing new files stays in Vibe Files; sending a file that
// is already here to someone outside the client, by a secure link, is done here (P49).

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, Input } from '@vibe/ui';

import { FirmLogo, reloadBranding } from '../branding';
import { ApiError } from '../api';
import {
  staffApi,
  staffSay,
  when,
  type ClientRow,
  type Invitation,
  type OutsideShare,
  type PortalUser,
  type SharedFile,
  type StaffMe,
  type StaffRow,
} from './api';

/** Sends the person to sign in when the session has ended (30 minutes idle, 12 hours). */
function useSignedOut(): (err: unknown) => boolean {
  const navigate = useNavigate();
  const nav = useRef(navigate);
  nav.current = navigate;
  return useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) {
      nav.current('/staff/login', { replace: true });
      return true;
    }
    return false;
  }, []);
}

/** Settings tells the header to read the firm name again. */
const ME_CHANGED = 'vibe-staff-me-changed';

/** An admin changed what this person may do while the page was open: the header reads it
 *  again, so the links match (the server refused the call either way). */
function rightsChanged(err: unknown): void {
  if (err instanceof ApiError && (err.code === 'admins_only' || err.code === 'all_clients_only')) {
    window.dispatchEvent(new Event(ME_CHANGED));
  }
}

interface Load<T> {
  data: T | null;
  error: string;
  reload: () => void;
}

/** Loads `path`; `reload` reads it again. */
function useLoad<T>(path: string): Load<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const signedOut = useSignedOut();
  const reload = useCallback(() => {
    setError('');
    staffApi<T>(path)
      .then(setData)
      .catch((err: unknown) => {
        rightsChanged(err);
        if (!signedOut(err)) setError(staffSay(err));
      });
  }, [path, signedOut]);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

/** Runs a change, then reloads; shows what went wrong. */
function useAct(reload: () => void): {
  act: (path: string, init: { method?: string; body?: unknown; raw?: Blob }) => Promise<unknown>;
  busy: boolean;
  error: string;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const signedOut = useSignedOut();
  const act = async (path: string, init: { method?: string; body?: unknown; raw?: Blob }) => {
    setBusy(true);
    setError('');
    try {
      const r = await staffApi(path, init);
      reload();
      return r;
    } catch (err) {
      rightsChanged(err);
      if (!signedOut(err)) setError(staffSay(err));
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { act, busy, error };
}

function Problem({ text }: { text: string }): JSX.Element | null {
  return text ? <p role="alert">{text}</p> : null;
}

/** Loading, or what went wrong with Try again; nothing once loaded. */
function Status({ load, what }: { load: Load<unknown>; what: string }): JSX.Element | null {
  if (load.error) {
    return (
      <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <span>
          Could not load {what}: {load.error}
        </span>
        <Button size="sm" variant="secondary" onClick={load.reload}>
          Try again
        </Button>
      </div>
    );
  }
  return load.data === null ? <p role="status">Loading {what}…</p> : null;
}

export function StaffHome(): JSX.Element {
  const me = useLoad<StaffMe>('/auth/me');
  const navigate = useNavigate();
  const reloadMe = me.reload;
  useEffect(() => {
    window.addEventListener(ME_CHANGED, reloadMe);
    return () => window.removeEventListener(ME_CHANGED, reloadMe);
  }, [reloadMe]);
  if (!me.data) {
    return (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16 }}>
        <Status load={me} what="the staff page" />
      </div>
    );
  }
  const signOut = async (): Promise<void> => {
    await staffApi('/auth/logout', { method: 'POST' }).catch(() => undefined);
    navigate('/staff/login', { replace: true });
  };
  // Settings are for admins; access requests for staff who see every client.
  const { admin, allClients } = me.data;
  const nav = [
    'Clients',
    ...(allClients ? ['Requests'] : []),
    'Uploads',
    'History',
    ...(admin ? ['Settings'] : []),
  ];
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16, display: 'grid', gap: 16 }}>
      <header style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <FirmLogo height={32} />
        <strong>{me.data.firmName} · portal staff</strong>
        <nav aria-label="Staff" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {nav.map((n) => (
            <NavLink key={n} to={n === 'Clients' ? '/staff' : `/staff/${n.toLowerCase()}`} end>
              {n}
            </NavLink>
          ))}
        </nav>
        <span style={{ marginLeft: 'auto' }}>{me.data.name}</span>
        <Button size="sm" variant="secondary" onClick={() => void signOut()}>
          Sign out
        </Button>
      </header>
      <Routes>
        <Route index element={<Clients limited={!allClients} />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        {allClients && <Route path="requests" element={<Requests />} />}
        <Route path="uploads" element={<Uploads />} />
        <Route path="history" element={<History />} />
        {admin && <Route path="settings" element={<Settings />} />}
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Routes>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }): JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '6px 8px' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

const td = { padding: '6px 8px', borderTop: '1px solid var(--vibe-border, #ddd)' };

function Clients({ limited }: { limited: boolean }): JSX.Element {
  const load = useLoad<{ clients: ClientRow[] }>('/v1/clients');
  const [q, setQ] = useState('');
  const rows = (load.data?.clients ?? []).filter((c) =>
    `${c.displayName} ${c.clientCode}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  return (
    <Card title="Clients">
      <p>
        Clients appear here once Vibe Files has shared a file or invited someone for them. Files are
        shared from Vibe Files.
      </p>
      {limited && <p>You see the clients an admin chose for you.</p>}
      <Input label="Find a client" name="q" value={q} onChange={(e) => setQ(e.target.value)} />
      <Status load={load} what="the clients" />
      {load.data && rows.length === 0 && (
        <p>
          {q.trim()
            ? 'No client matches.'
            : limited
              ? 'No clients chosen for you yet.'
              : 'No clients on the portal yet.'}
        </p>
      )}
      <Table head={['Client', 'ID', 'People', 'Files', 'Uploads waiting']}>
        {rows.map((c) => (
          <tr key={c.id}>
            <td style={td}>
              <Link to={`/staff/clients/${c.id}`}>{c.displayName}</Link>
              {!c.active && ' (switched off)'}
            </td>
            <td style={td}>{c.clientCode}</td>
            <td style={td}>{c.users}</td>
            <td style={td}>{c.files}</td>
            <td style={td}>{c.waiting}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

function ClientDetail(): JSX.Element {
  const { id = '' } = useParams();
  const people = useLoad<{ users: PortalUser[]; invitations: Invitation[] }>(
    `/v1/clients/${id}/users`,
  );
  const files = useLoad<{ files: SharedFile[] }>(`/v1/files?clientId=${id}`);
  const links = useLoad<{ shares: OutsideShare[] }>(`/v1/shares?clientId=${id}`);
  const reload = (): void => {
    people.reload();
    files.reload();
    links.reload();
  };
  /** The file "Send securely" was pressed on, while its form is open. */
  const [sending, setSending] = useState<string | null>(null);
  const [sentNote, setSentNote] = useState('');
  const { act, busy, error } = useAct(reload);
  const [inv, setInv] = useState({ email: '', phone: '', name: '', roleLabel: '' });
  /** The invite form, shown only after "Invite someone" is pressed (P54). */
  const [inviting, setInviting] = useState(false);
  const label = (u: PortalUser): string => u.name || u.email || u.phone || '?';
  const head = useLoad<ClientRow>(`/v1/clients/${id}`);
  const uploads = useLoad<{ uploads: UploadRow[] }>(`/v1/uploads?clientId=${id}`);
  const invite = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(inv).filter(([, v]) => v.trim() !== ''));
    if (await act(`/v1/clients/${id}/invites`, { body })) {
      setInv({ email: '', phone: '', name: '', roleLabel: '' });
      setInviting(false);
      head.reload();
    }
  };
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Link to="/staff">← All clients</Link>
      <ClientHead load={head} />
      <Problem text={error} />
      <Card title="People with access">
        <Status load={people} what="the people" />
        {people.data && people.data.users.length === 0 && people.data.invitations.length === 0 && (
          <p>Nobody has access yet.</p>
        )}
        <Table head={['Name', 'Email / phone', 'Role', 'Last sign-in', 'Actions']}>
          {(people.data?.users ?? []).map((u) => (
            <tr key={u.identityId}>
              <td style={td}>{label(u)}</td>
              <td style={td}>{u.email ?? u.phone}</td>
              <td style={td}>{u.roleLabel}</td>
              <td style={td}>{when(u.lastSignInAt)}</td>
              <td style={td}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`${u.active ? 'Turn off' : 'Turn on'} ${label(u)}`}
                  onClick={() =>
                    void act(`/v1/clients/${id}/users/${u.identityId}`, {
                      method: 'PATCH',
                      body: { active: !u.active },
                    })
                  }
                >
                  {u.active ? 'Turn off' : 'Turn on'}
                </Button>
              </td>
            </tr>
          ))}
          {(people.data?.invitations ?? []).map((i) => (
            <tr key={i.invitationId}>
              <td style={td}>{i.name || '—'}</td>
              <td style={td}>{i.email ?? i.phone}</td>
              <td style={td}>{i.roleLabel}</td>
              <td style={td}>
                {i.status === 'expired'
                  ? 'invitation expired'
                  : `invited until ${when(i.expiresAt)}`}
              </td>
              <td style={td}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  aria-label={`Withdraw the invitation to ${i.email ?? i.phone ?? ''}`}
                  onClick={() =>
                    void act(`/v1/clients/${id}/invites/${i.invitationId}`, { method: 'DELETE' })
                  }
                >
                  Withdraw
                </Button>
              </td>
            </tr>
          ))}
        </Table>
        {!inviting && (
          <div style={{ marginTop: 12 }}>
            <Button variant="secondary" onClick={() => setInviting(true)}>
              Invite someone
            </Button>
          </div>
        )}
        {inviting && (
          <form onSubmit={invite} style={{ display: 'grid', gap: 8, maxWidth: 420, marginTop: 12 }}>
            <strong>Invite someone</strong>
            <Input
              label="Email"
              name="email"
              value={inv.email}
              onChange={(e) => setInv({ ...inv, email: e.target.value })}
            />
            <Input
              label="Mobile number"
              name="phone"
              value={inv.phone}
              onChange={(e) => setInv({ ...inv, phone: e.target.value })}
            />
            <Input
              label="Name"
              name="name"
              value={inv.name}
              onChange={(e) => setInv({ ...inv, name: e.target.value })}
            />
            <Input
              label="Role (e.g. Spouse)"
              name="role"
              value={inv.roleLabel}
              onChange={(e) => setInv({ ...inv, roleLabel: e.target.value })}
            />
            <div style={{ display: 'flex', gap: 8 }}>
              <Button type="submit" disabled={busy || !(inv.email.trim() || inv.phone.trim())}>
                Send invitation
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setInviting(false);
                  setInv({ email: '', phone: '', name: '', roleLabel: '' });
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Card>
      <ClientFiles
        load={files}
        people={people.data?.users ?? []}
        label={label}
        busy={busy}
        act={act}
        onChanged={() => {
          files.reload();
          head.reload();
        }}
        onSend={(fileId) => {
          setSentNote('');
          setSending(fileId);
        }}
      />
      <ClientUploads load={uploads} />
      {sentNote && <p role="status">{sentNote}</p>}
      {sending && files.data && (
        <SendSecurely
          key={sending}
          clientId={id}
          files={files.data.files}
          first={sending}
          onSent={(note) => {
            setSending(null);
            setSentNote(note);
            links.reload();
          }}
          onCancel={() => setSending(null)}
        />
      )}
      <SecureLinks
        load={links}
        busy={busy}
        onRevoke={(s) => {
          if (
            window.confirm(
              `Revoke the link sent to ${s.email}? It stops working at once, even if it is open.`,
            )
          ) {
            void act(`/v1/shares/${s.id}`, { method: 'DELETE' });
          }
        }}
      />
    </div>
  );
}

/** The top of a client's page (P54): whose page this is, at a glance. */
function ClientHead({ load }: { load: Load<ClientRow> }): JSX.Element {
  const c = load.data;
  if (!c) return <Status load={load} what="the client" />;
  const n = (k: number, one: string, many: string): string => `${k} ${k === 1 ? one : many}`;
  return (
    <header style={{ display: 'grid', gap: 4 }}>
      <h1 style={{ margin: 0, fontSize: 24, display: 'flex', gap: 10, alignItems: 'center' }}>
        {c.displayName}
        {!c.active && (
          <span
            style={{
              fontSize: 12,
              padding: '2px 8px',
              borderRadius: 999,
              border: '1px solid currentColor',
              opacity: 0.8,
            }}
          >
            Off
          </span>
        )}
      </h1>
      <p style={{ margin: 0, opacity: 0.8 }}>
        {c.clientCode ? `Client ${c.clientCode} · ` : ''}
        {n(c.users, 'person', 'people')} with access · {n(c.files, 'file', 'files')} on the portal ·{' '}
        {n(c.waiting, 'upload', 'uploads')} waiting for Vibe Files
        {!c.active && ' · switched off in Vibe Files: nobody can sign in for this client'}
      </p>
    </header>
  );
}

type FileSort = 'newest' | 'name' | 'year';

/** A client's files on the portal (P54): find, filter, sort, in tax-year folders, and show,
 *  hide or remove several at once. Files still come only from Vibe Files. */
function ClientFiles({
  load,
  people,
  label,
  busy,
  act,
  onChanged,
  onSend,
}: {
  load: Load<{ files: SharedFile[] }>;
  people: PortalUser[];
  label: (u: PortalUser) => string;
  busy: boolean;
  act: (path: string, init: { method?: string; body?: unknown }) => Promise<unknown>;
  onChanged: () => void;
  onSend: (fileId: string) => void;
}): JSX.Element {
  const [q, setQ] = useState('');
  const [year, setYear] = useState('all');
  const [sort, setSort] = useState<FileSort>('newest');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [who, setWho] = useState<Set<string> | null>(null);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState('');
  const all = load.data?.files ?? [];
  const activePeople = people.filter((p) => p.active);
  // Everyone with access, until the staff member narrows it.
  const chosen = who ?? new Set(activePeople.map((p) => p.identityId));
  const years = [...new Set(all.map((f) => f.taxYear))].sort((a, b) => (b ?? 0) - (a ?? 0));
  const shown = all
    .filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase()))
    .filter((f) => year === 'all' || String(f.taxYear ?? 'none') === year)
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : sort === 'year'
          ? (b.taxYear ?? 0) - (a.taxYear ?? 0) || a.name.localeCompare(b.name)
          : b.sharedAt.localeCompare(a.sharedAt),
    );
  const folders = years
    .map((y) => ({ year: y, files: shown.filter((f) => f.taxYear === y) }))
    .filter((g) => g.files.length > 0);
  const toggle = (ids: string[], on: boolean): void => {
    const next = new Set(picked);
    for (const i of ids) {
      if (on) next.add(i);
      else next.delete(i);
    }
    setPicked(next);
  };
  const pickedFiles = all.filter((f) => picked.has(f.fileId));

  /** One call per file; the list is read again once at the end. */
  const many = async (what: (f: SharedFile) => Promise<unknown>): Promise<void> => {
    setWorking(true);
    setProblem('');
    try {
      for (const f of pickedFiles) await what(f);
      setPicked(new Set());
    } catch (err) {
      setProblem(staffSay(err));
    } finally {
      setWorking(false);
      onChanged();
    }
  };
  const visibility = (visible: boolean): Promise<void> =>
    many((f) =>
      staffApi(`/v1/files/${f.fileId}/visibility`, {
        method: 'PUT',
        body: { users: Object.fromEntries([...chosen].map((i) => [i, visible])) },
      }),
    );
  const off = busy || working;

  const row = (f: SharedFile): JSX.Element => (
    <tr key={f.fileId}>
      <td style={{ ...td, width: 28 }}>
        <input
          type="checkbox"
          aria-label={`Select ${f.name}`}
          checked={picked.has(f.fileId)}
          onChange={(e) => toggle([f.fileId], e.target.checked)}
        />
      </td>
      <td style={td}>
        {f.name}
        {f.contentUpdatedAt && ` (updated ${when(f.contentUpdatedAt)})`}
      </td>
      <td style={td}>
        {when(f.sharedAt)} by {f.sharedBy}
      </td>
      <td style={td}>
        {f.users.filter((x) => x.visible).length === 0 && 'nobody'}
        {f.users
          .filter((x) => x.visible)
          .map((x) => {
            const u = people.find((p) => p.identityId === x.identityId);
            return (
              <span key={x.identityId} style={{ display: 'inline-flex', gap: 4, marginRight: 8 }}>
                {u ? label(u) : 'someone'} (
                {x.viewedAt ? `opened ${when(x.viewedAt)}` : 'not opened'})
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={off}
                  aria-label={`Hide ${f.name} from ${u ? label(u) : 'this person'}`}
                  onClick={() =>
                    void act(`/v1/files/${f.fileId}/visibility`, {
                      method: 'PUT',
                      body: { users: { [x.identityId]: false } },
                    })
                  }
                >
                  Hide
                </Button>
              </span>
            );
          })}
      </td>
      <td style={td}>
        <Button
          size="sm"
          variant="secondary"
          disabled={off}
          aria-label={`Send ${f.name} securely`}
          style={{ marginRight: 6 }}
          onClick={() => onSend(f.fileId)}
        >
          Send securely…
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={off}
          aria-label={`Remove ${f.name}`}
          onClick={() => {
            if (
              window.confirm(`Remove ${f.name} from the portal for everyone? The cabinet keeps it.`)
            ) {
              void act(`/v1/files/${f.fileId}`, { method: 'DELETE' });
            }
          }}
        >
          Remove
        </Button>
      </td>
    </tr>
  );

  return (
    <Card title="Files on the portal">
      <Status load={load} what="the files" />
      <Problem text={problem} />
      {load.data && all.length === 0 && (
        <p>No files on the portal for this client. Files are shared from Vibe Files.</p>
      )}
      {all.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ minWidth: 220, flex: 1 }}>
            <Input
              label="Find a file"
              name="fileSearch"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13 }}>Tax year</span>
            <select value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="all">All years</option>
              {years.map((y) => (
                <option key={y ?? 'none'} value={String(y ?? 'none')}>
                  {y ?? 'No tax year'}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 13 }}>Sort</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as FileSort)}>
              <option value="newest">Newest first</option>
              <option value="name">Name</option>
              <option value="year">Tax year</option>
            </select>
          </label>
        </div>
      )}
      {picked.size > 0 && (
        <div
          role="region"
          aria-label="Selected files"
          style={{
            display: 'grid',
            gap: 8,
            padding: 12,
            margin: '12px 0',
            border: '1px solid var(--vibe-color-border)',
            borderRadius: 8,
          }}
        >
          <strong>
            {picked.size} {picked.size === 1 ? 'file' : 'files'} selected
          </strong>
          {activePeople.length > 0 && (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>For:</span>
              {activePeople.map((p) => (
                <label key={p.identityId} style={{ display: 'inline-flex', gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={chosen.has(p.identityId)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(p.identityId);
                      else next.delete(p.identityId);
                      setWho(next);
                    }}
                  />
                  {label(p)}
                </label>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button
              size="sm"
              disabled={off || chosen.size === 0}
              onClick={() => void visibility(true)}
            >
              Show to them
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={off || chosen.size === 0}
              onClick={() => void visibility(false)}
            >
              Hide from them
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={off}
              onClick={() => {
                if (
                  window.confirm(
                    `Remove ${picked.size} ${picked.size === 1 ? 'file' : 'files'} from the portal for everyone? The cabinet keeps them.`,
                  )
                ) {
                  void many((f) => staffApi(`/v1/files/${f.fileId}`, { method: 'DELETE' }));
                }
              }}
            >
              Remove from portal
            </Button>
            <Button size="sm" variant="ghost" disabled={off} onClick={() => setPicked(new Set())}>
              Clear selection
            </Button>
          </div>
        </div>
      )}
      {all.length > 0 && shown.length === 0 && <p>No file matches.</p>}
      {folders.map((g) => {
        const ids = g.files.map((f) => f.fileId);
        const allPicked = ids.every((i) => picked.has(i));
        return (
          <details key={g.year ?? 'none'} open style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                aria-label={`Select every file in ${g.year ?? 'No tax year'}`}
                checked={allPicked}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => toggle(ids, e.target.checked)}
              />
              <strong>{g.year ?? 'No tax year'}</strong>
              <span style={{ opacity: 0.7 }}>
                {g.files.length} {g.files.length === 1 ? 'file' : 'files'}
              </span>
            </summary>
            <Table head={['', 'File', 'Shared', 'Who sees it', 'Actions']}>
              {g.files.map(row)}
            </Table>
          </details>
        );
      })}
    </Card>
  );
}

/** What this client sent that Vibe Files has not collected yet (P54). */
function ClientUploads({ load }: { load: Load<{ uploads: UploadRow[] }> }): JSX.Element {
  const list = load.data?.uploads ?? [];
  return (
    <Card title="Uploads waiting for Vibe Files">
      <Status load={load} what="the uploads" />
      {load.data && list.length === 0 && (
        <p>Nothing waiting from this client: Vibe Files has collected everything.</p>
      )}
      {list.length > 0 && (
        <Table head={['Received', 'File', 'From', 'Note']}>
          {list.map((u) => (
            <tr key={u.uploadId}>
              <td style={td}>{when(u.uploadedAt)}</td>
              <td style={td}>
                <a href={`/api/staff/v1/uploads/${u.uploadId}/content`} download={u.name}>
                  {u.name}
                </a>
              </td>
              <td style={td}>{u.from.name || u.from.email || u.from.phone}</td>
              <td style={td}>{u.note}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

/** The form that sends files of one client to someone outside it, by a secure link (P49). */
function SendSecurely({
  clientId,
  files,
  first,
  onSent,
  onCancel,
}: {
  clientId: string;
  files: SharedFile[];
  first: string;
  onSent: (note: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { act, busy, error } = useAct(() => undefined);
  const [picked, setPicked] = useState<Set<string>>(new Set([first]));
  const [to, setTo] = useState({ email: '', name: '', organization: '', message: '' });
  const [download, setDownload] = useState(false);
  const [watermark, setWatermark] = useState(false);
  const [days, setDays] = useState(30);
  const toggle = (fileId: string, on: boolean): void => {
    const next = new Set(picked);
    if (on) next.add(fileId);
    else next.delete(fileId);
    setPicked(next);
  };
  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const email = to.email.trim();
    const made = await act('/v1/shares', {
      body: {
        clientId,
        fileIds: files.filter((f) => picked.has(f.fileId)).map((f) => f.fileId),
        email,
        name: to.name.trim(),
        organization: to.organization.trim(),
        message: to.message.trim(),
        canDownload: download,
        watermark,
        days,
      },
    });
    if (made) {
      onSent(
        `Secure link sent to ${email}. It expires in ${days} days and can be revoked anytime.`,
      );
    }
  };
  const row = { display: 'flex', gap: 6, alignItems: 'center' };
  return (
    <Card title="Send securely to someone outside the client">
      <form onSubmit={send} style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
        <p style={{ margin: 0 }}>
          For a lender, a lawyer or another accountant. They get an email with a private link, and
          must enter a one-time code sent to the same address before they see anything. They do not
          get a portal account.
        </p>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 4 }}>
          <legend style={{ padding: 0, fontWeight: 600 }}>Files to send</legend>
          {files.map((f) => (
            <label key={f.fileId} style={row}>
              <input
                type="checkbox"
                checked={picked.has(f.fileId)}
                onChange={(e) => toggle(f.fileId, e.target.checked)}
              />
              <span style={{ overflowWrap: 'anywhere' }}>{f.name}</span>
            </label>
          ))}
        </fieldset>
        <Input
          label="Recipient email"
          name="shareEmail"
          type="email"
          value={to.email}
          onChange={(e) => setTo({ ...to, email: e.target.value })}
        />
        <Input
          label="Recipient name"
          name="shareName"
          maxLength={120}
          value={to.name}
          onChange={(e) => setTo({ ...to, name: e.target.value })}
        />
        <Input
          label="Organization"
          name="shareOrganization"
          maxLength={120}
          value={to.organization}
          onChange={(e) => setTo({ ...to, organization: e.target.value })}
        />
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Access</span>
          <select
            value={download ? 'download' : 'view'}
            onChange={(e) => setDownload(e.target.value === 'download')}
          >
            <option value="view">View only (PDFs and pictures)</option>
            <option value="download">View and download</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Link works for</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </label>
        <label style={row}>
          <input
            type="checkbox"
            checked={watermark}
            onChange={(e) => setWatermark(e.target.checked)}
          />
          <span>Watermark PDFs with the recipient&apos;s name and the date</span>
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Message in the email (optional)</span>
          <textarea
            rows={3}
            maxLength={1000}
            value={to.message}
            onChange={(e) => setTo({ ...to, message: e.target.value })}
          />
        </label>
        {!download && (
          <p style={{ margin: 0, fontSize: 13 }}>
            View only shows the document on the page with no download button. It cannot stop a
            screenshot.
          </p>
        )}
        <Problem text={error} />
        <div style={{ display: 'flex', gap: 8 }}>
          <Button type="submit" disabled={busy || picked.size === 0 || !to.email.trim()}>
            Send secure link
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

const SHARE_STATE: Record<OutsideShare['status'], string> = {
  sent: 'Sent, not opened',
  opened: 'Opened',
  expired: 'Expired',
  revoked: 'Revoked',
  locked: 'Locked: too many wrong codes',
};

/** The secure links sent for one client, and the button that ends one (P49). */
function SecureLinks({
  load,
  busy,
  onRevoke,
}: {
  load: Load<{ shares: OutsideShare[] }>;
  busy: boolean;
  onRevoke: (share: OutsideShare) => void;
}): JSX.Element {
  const shares = load.data?.shares ?? [];
  return (
    <Card title="Secure links sent outside">
      <Status load={load} what="the secure links" />
      {load.data && shares.length === 0 && (
        <p>None yet. Use &ldquo;Send securely&rdquo; beside a file above.</p>
      )}
      {shares.length > 0 && (
        <Table head={['To', 'Files', 'Access', 'State', 'Sent', 'Expires', 'Opened', 'Actions']}>
          {shares.map((s) => (
            <tr key={s.id}>
              <td style={td}>
                {s.name ? `${s.name} (${s.email})` : s.email}
                {s.organization && `, ${s.organization}`}
              </td>
              <td style={td}>
                {s.files.map((f) => (f.removed ? `${f.name} (removed)` : f.name)).join(', ')}
              </td>
              <td style={td}>
                {s.canDownload ? 'View and download' : 'View only'}
                {s.watermark && ', watermarked'}
              </td>
              <td style={td}>
                {SHARE_STATE[s.status]}
                {s.status === 'revoked' && ` ${when(s.revokedAt)}`}
              </td>
              <td style={td}>
                {when(s.createdAt)} by {s.createdBy}
              </td>
              <td style={td}>{when(s.expiresAt)}</td>
              <td style={td}>
                {s.opens === 0
                  ? '—'
                  : `${s.opens} ${s.opens === 1 ? 'time' : 'times'}, last ${when(s.lastOpenedAt)}`}
              </td>
              <td style={td}>
                {(s.status === 'sent' || s.status === 'opened') && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    aria-label={`Revoke the link sent to ${s.email}`}
                    onClick={() => onRevoke(s)}
                  >
                    Revoke
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

interface AccessRequestRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  confirmedContact: string | null;
  clientAs: string;
  note: string;
  createdAt: string;
}

function Requests(): JSX.Element {
  const reqs = useLoad<{ requests: AccessRequestRow[] }>('/v1/access-requests');
  const clients = useLoad<{ clients: ClientRow[] }>('/v1/clients');
  const { act, busy, error } = useAct(reqs.reload);
  const [pick, setPick] = useState<Record<string, { client: string; role: string }>>({});
  return (
    <Card title="Access requests">
      <p>
        People who asked for access and confirmed their email or phone. Only the confirmed contact
        is used.
      </p>
      <Problem text={error} />
      <Status load={reqs} what="the requests" />
      <Status load={clients} what="the clients" />
      {reqs.data?.requests.length === 0 && <p>No requests waiting.</p>}
      {(reqs.data?.requests ?? []).map((r) => {
        const p = pick[r.id] ?? { client: '', role: '' };
        const set = (v: Partial<typeof p>): void => setPick({ ...pick, [r.id]: { ...p, ...v } });
        return (
          <div
            key={r.id}
            style={{
              borderTop: '1px solid var(--vibe-border, #ddd)',
              padding: '8px 0',
              display: 'grid',
              gap: 6,
            }}
          >
            <strong>{r.name}</strong>
            <span>
              Confirmed: {r.confirmedContact} · asked for “{r.clientAs}” · {when(r.createdAt)}
            </span>
            {r.note && <span>“{r.note}”</span>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span>Client for {r.name}</span>
                <select value={p.client} onChange={(e) => set({ client: e.target.value })}>
                  <option value="">Choose…</option>
                  {(clients.data?.clients ?? [])
                    .filter((c) => c.active)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.displayName} {c.clientCode && `(${c.clientCode})`}
                      </option>
                    ))}
                </select>
              </label>
              <Input
                label={`Role for ${r.name}`}
                name={`role-${r.id}`}
                value={p.role}
                onChange={(e) => set({ role: e.target.value })}
              />
              <Button
                disabled={busy || !p.client}
                aria-label={`Approve ${r.name}`}
                onClick={() =>
                  void act(`/v1/access-requests/${r.id}/approve`, {
                    body: { clientId: p.client, roleLabel: p.role },
                  })
                }
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                aria-label={`Deny ${r.name}`}
                onClick={() => void act(`/v1/access-requests/${r.id}/deny`, { method: 'POST' })}
              >
                Deny
              </Button>
            </div>
          </div>
        );
      })}
      <p>
        A client not listed here: share a file or invite someone for them from Vibe Files first.
      </p>
    </Card>
  );
}

interface UploadRow {
  uploadId: string;
  clientName: string;
  clientCode: string;
  name: string;
  size: number;
  note: string;
  uploadedAt: string;
  from: { name: string; email: string | null; phone: string | null };
}

function Uploads(): JSX.Element {
  const load = useLoad<{ uploads: UploadRow[] }>('/v1/uploads');
  const data = load.data;
  return (
    <Card title="Uploads waiting for Vibe Files">
      <p>
        What clients sent that Vibe Files has not collected yet. Downloading here does not take it
        out of Intake: Vibe Files still files it.
      </p>
      <Status load={load} what="the uploads" />
      {data?.uploads.length === 0 && <p>Nothing waiting: Vibe Files has collected everything.</p>}
      <Table head={['Received', 'Client', 'File', 'From', 'Note']}>
        {(data?.uploads ?? []).map((u) => (
          <tr key={u.uploadId}>
            <td style={td}>{when(u.uploadedAt)}</td>
            <td style={td}>
              {u.clientName} {u.clientCode && `(${u.clientCode})`}
            </td>
            <td style={td}>
              <a href={`/api/staff/v1/uploads/${u.uploadId}/content`} download={u.name}>
                {u.name}
              </a>
            </td>
            <td style={td}>{u.from.name || u.from.email || u.from.phone}</td>
            <td style={td}>{u.note}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

interface EventRow {
  id: number;
  at: string;
  kind: string;
  actorKind: string;
  actor: string;
  clientId: string | null;
  detail: Record<string, unknown>;
}

function History(): JSX.Element {
  const load = useLoad<{ events: EventRow[] }>('/v1/events?latest=1&limit=300');
  const rows = load.data?.events ?? [];
  return (
    <Card title="History">
      <p>
        The newest 300 events: sign-ins, invitations, sharing, client views and downloads, uploads,
        and secure links sent outside (&ldquo;outside&rdquo; events).
      </p>
      <Status load={load} what="the history" />
      {load.data && rows.length === 0 && <p>Nothing has happened yet.</p>}
      <Table head={['When', 'What', 'Who']}>
        {rows.map((e) => (
          <tr key={e.id}>
            <td style={td}>{when(e.at)}</td>
            <td style={td}>{e.kind.replace(/_/g, ' ')}</td>
            <td style={td}>{e.actorKind === 'client' ? 'a client' : e.actor}</td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

interface SettingsData {
  firmName: string;
  accentColor: string;
  uploadLimitMb: number;
  uploadKeepDays: number;
  hasLogo: boolean;
  portalUrl: string;
}

function Settings(): JSX.Element {
  const s = useLoad<SettingsData>('/v1/settings');
  const keys = useLoad<{
    keys: {
      id: string;
      label: string;
      createdAt: string;
      lastUsedAt: string | null;
      revokedAt: string | null;
    }[];
  }>('/v1/keys');
  const staff = useLoad<{ staff: StaffRow[] }>('/v1/staff');
  const me = useLoad<StaffMe>('/auth/me');
  const clients = useLoad<{ clients: ClientRow[] }>('/v1/clients');
  const reload = (): void => {
    s.reload();
    keys.reload();
    staff.reload();
  };
  const { act: run, busy, error } = useAct(reload);
  const [form, setForm] = useState<SettingsData | null>(null);
  const [newKey, setNewKey] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [person, setPerson] = useState({ email: '', name: '', admin: false });
  // The staff member whose access is being changed.
  const [access, setAccess] = useState<StaffRow | null>(null);
  const [link, setLink] = useState<{ who: string; url: string } | null>(null);
  // Bumped when the logo changes, so the browser shows the new one (it caches it).
  const [logoV, setLogoV] = useState(0);
  // A key or setup link is shown until the next thing done here.
  const act: typeof run = (path, init) => {
    setNewKey('');
    setLink(null);
    return run(path, init);
  };
  useEffect(() => {
    if (s.data && !form) setForm(s.data);
  }, [s.data, form]);
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Problem text={error} />
      <Status load={s} what="the settings" />
      {form && (
        <Card title="Firm">
          <form
            style={{ display: 'grid', gap: 8, maxWidth: 420 }}
            onSubmit={(e) => {
              e.preventDefault();
              void act('/v1/settings', {
                method: 'PUT',
                body: {
                  firmName: form.firmName,
                  accentColor: form.accentColor,
                  uploadLimitMb: Number(form.uploadLimitMb),
                  uploadKeepDays: Number(form.uploadKeepDays),
                },
              }).then((r) => {
                if (r) {
                  // Shown as saved (trimmed), and in the header.
                  setForm(null);
                  window.dispatchEvent(new Event(ME_CHANGED));
                  // The new name and colour on every page now, not after a reload.
                  reloadBranding();
                }
              });
            }}
          >
            <Input
              label="Firm name (shown to clients)"
              name="firmName"
              value={form.firmName}
              onChange={(e) => setForm({ ...form, firmName: e.target.value })}
            />
            <Input
              label="Colour"
              name="accentColor"
              type="color"
              value={form.accentColor}
              onChange={(e) => setForm({ ...form, accentColor: e.target.value })}
            />
            <Input
              label="Largest file clients may send, and Vibe Files may share (MB, at most 95)"
              name="limit"
              type="number"
              min={1}
              max={95}
              value={form.uploadLimitMb}
              onChange={(e) => setForm({ ...form, uploadLimitMb: Number(e.target.value) })}
            />
            <Input
              label="Keep files Vibe Files collected for (days)"
              name="keep"
              type="number"
              min={0}
              value={form.uploadKeepDays}
              onChange={(e) => setForm({ ...form, uploadKeepDays: Number(e.target.value) })}
            />
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </form>
          <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
            <strong>Logo</strong>
            {s.data?.hasLogo && (
              <img
                src={`/api/portal/branding/logo?v=${logoV}`}
                alt="Firm logo"
                style={{ maxHeight: 60, maxWidth: 240 }}
              />
            )}
            <label>
              <span>PNG or JPEG, at most 512 KB </span>
              <input
                type="file"
                accept="image/png,image/jpeg"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  // Cleared, so the same file can be chosen again.
                  e.target.value = '';
                  if (f) {
                    void act('/v1/settings/logo', { method: 'PUT', raw: f }).then((r) => {
                      if (r) {
                        setLogoV((v) => v + 1);
                        reloadBranding();
                      }
                    });
                  }
                }}
              />
            </label>
            {s.data?.hasLogo && (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void act('/v1/settings/logo', { method: 'DELETE' }).then(() => {
                    setLogoV((v) => v + 1);
                    reloadBranding();
                  })
                }
              >
                Remove logo
              </Button>
            )}
          </div>
        </Card>
      )}
      <Card title="Portal keys (for Vibe Files › Admin › Portal)">
        <Status load={keys} what="the keys" />
        <Table head={['Name', 'Made', 'Last used', 'Actions']}>
          {(keys.data?.keys ?? []).map((k) => (
            <tr key={k.id}>
              <td style={td}>{k.label}</td>
              <td style={td}>{when(k.createdAt)}</td>
              <td style={td}>
                {k.revokedAt ? `revoked ${when(k.revokedAt)}` : when(k.lastUsedAt)}
              </td>
              <td style={td}>
                {!k.revokedAt && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    aria-label={`Revoke ${k.label}`}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Revoke ${k.label}? Vibe Files stops reaching the portal until a new key is pasted.`,
                        )
                      ) {
                        void act(`/v1/keys/${k.id}`, { method: 'DELETE' });
                      }
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
        <form
          style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void act('/v1/keys', { body: { label: keyLabel } }).then((r) => {
              const k = (r as { key?: string } | null)?.key;
              if (k) {
                setNewKey(k);
                setKeyLabel('');
              }
            });
          }}
        >
          <Input
            label="New key name"
            name="keyLabel"
            value={keyLabel}
            onChange={(e) => setKeyLabel(e.target.value)}
          />
          <Button type="submit" disabled={busy || !keyLabel.trim()}>
            Make a key
          </Button>
        </form>
        {newKey && (
          <p role="status">
            Paste this into Vibe Files › Admin › Portal now; it is not shown again:{' '}
            <code>{newKey}</code>
          </p>
        )}
      </Card>
      <Card title="Staff">
        <Status load={staff} what="the staff" />
        <p>
          An admin uses Settings. Other staff see every client unless you limit them to some with{' '}
          <strong>Access</strong>.
        </p>
        <p>
          <strong>Clients may notify</strong>: a client sending files can choose to have this
          person emailed, with the file names and their note. Clients see the names of those
          ticked who can see their client, never their email addresses.
        </p>
        <Table
          head={['Name', 'Email', 'State', 'Sees', 'Clients may notify', 'Last sign-in', 'Actions']}
        >
          {(staff.data?.staff ?? []).map((u) => {
            const self = u.email === me.data?.email;
            // No buttons until it is known which row is yours.
            const other = me.data !== null && !self;
            return (
              <tr key={u.id}>
                <td style={td}>{u.name}</td>
                <td style={td}>{u.email}</td>
                <td style={td}>
                  {self ? 'you' : !u.active ? 'turned off' : u.ready ? 'active' : 'setting up'}
                </td>
                <td style={td}>
                  {u.admin
                    ? 'Admin: every client'
                    : u.clientIds
                      ? `${u.clientIds.length} ${u.clientIds.length === 1 ? 'client' : 'clients'}`
                      : 'Every client'}
                </td>
                <td style={td}>
                  {/* P56: clients sending files may ask that this person be told. */}
                  <input
                    type="checkbox"
                    aria-label={`Clients may notify ${u.name}`}
                    checked={u.notifyUploads}
                    disabled={busy || !u.active || me.data === null}
                    onChange={(e) =>
                      void act(`/v1/staff/${u.id}`, {
                        method: 'PATCH',
                        body: { notifyUploads: e.target.checked },
                      })
                    }
                  />
                </td>
                <td style={td}>{when(u.lastSignInAt)}</td>
                <td style={td}>
                  {other && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      aria-label={`Access for ${u.name}`}
                      onClick={() => {
                        // A client added since the page opened can be ticked.
                        clients.reload();
                        setAccess(u);
                      }}
                    >
                      Access
                    </Button>
                  )}{' '}
                  {other && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      aria-label={`${u.active ? 'Turn off' : 'Turn on'} ${u.name}`}
                      onClick={() =>
                        void act(`/v1/staff/${u.id}`, {
                          method: 'PATCH',
                          body: { active: !u.active },
                        })
                      }
                    >
                      {u.active ? 'Turn off' : 'Turn on'}
                    </Button>
                  )}{' '}
                  {other && u.active && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      aria-label={`New setup link for ${u.name}`}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Send ${u.name} a new setup link? Their password and authenticator stop working until they use it.`,
                          )
                        ) {
                          return;
                        }
                        void act(`/v1/staff/${u.id}/reset`, { method: 'POST' }).then((r) => {
                          const l = (r as { setupLink?: string } | null)?.setupLink;
                          if (l) setLink({ who: `${u.name} (${u.email})`, url: l });
                        });
                      }}
                    >
                      New setup link
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
        {access && (
          <StaffAccess
            key={access.id}
            who={access}
            clients={clients}
            busy={busy}
            error={error}
            onCancel={() => setAccess(null)}
            onSave={(change) =>
              void act(`/v1/staff/${access.id}`, { method: 'PATCH', body: change }).then((r) => {
                if (r) setAccess(null);
              })
            }
          />
        )}
        <form
          style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void act('/v1/staff', { body: person }).then((r) => {
              const l = (r as { setupLink?: string } | null)?.setupLink;
              if (l) {
                setLink({ who: `${person.name} (${person.email.trim()})`, url: l });
                setPerson({ email: '', name: '', admin: false });
              }
            });
          }}
        >
          <Input
            label="Email"
            name="staffEmail"
            value={person.email}
            onChange={(e) => setPerson({ ...person, email: e.target.value })}
          />
          <Input
            label="Name"
            name="staffName"
            value={person.name}
            onChange={(e) => setPerson({ ...person, name: e.target.value })}
          />
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={person.admin}
              onChange={(e) => setPerson({ ...person, admin: e.target.checked })}
            />
            <span>Admin</span>
          </label>
          <Button type="submit" disabled={busy || !person.email.trim() || !person.name.trim()}>
            Add staff
          </Button>
        </form>
        {link && (
          <p role="status">
            Setup link for {link.who} (also emailed to them; works for 3 days, once):{' '}
            <code style={{ wordBreak: 'break-all' }}>{link.url}</code>
          </p>
        )}
      </Card>
      <Storage />
    </div>
  );
}

interface StorageData {
  storage: 'local' | 'b2';
  bothInUse: boolean;
  b2: { endpoint: string; bucket: string; keyId: string; hasKey: boolean };
  move: {
    to: 'local' | 'b2';
    state: 'requested' | 'running' | 'done' | 'failed' | 'interrupted';
    by: string;
    startedAt?: string;
    finishedAt?: string;
    copied?: number;
    total?: number;
    error?: string;
    attempts?: number;
  } | null;
  note: {
    sweptAt?: string;
    refused?: { at: string; count: number; total: number } | null;
    otherBucket?: boolean;
    snapshotAt?: string;
    snapshotError?: string | null;
  } | null;
}

const PLACE = { local: 'on the appliance', b2: 'in the B2 bucket' } as const;

/** Where stored files live, the B2 bucket, and moving files there or back (P51). */
function Storage(): JSX.Element {
  const s = useLoad<StorageData>('/v1/settings/storage');
  const { act, busy, error } = useAct(s.reload);
  const [b2, setB2] = useState({ endpoint: '', bucket: '', keyId: '', appKey: '' });
  const [tested, setTested] = useState(false);
  const d = s.data;
  // Filled from what is saved when that changes, not on every reload (a move reloads every 2 s
  // and would wipe what the admin is typing).
  const saved = d ? `${d.b2.endpoint}\n${d.b2.bucket}\n${d.b2.keyId}` : null;
  useEffect(() => {
    if (saved === null) return;
    const [endpoint = '', bucket = '', keyId = ''] = saved.split('\n');
    setB2((v) => ({ ...v, endpoint, bucket, keyId }));
  }, [saved]);
  const running = d?.move?.state === 'requested' || d?.move?.state === 'running';
  // Follow a move while it runs.
  useEffect(() => {
    if (!running) return undefined;
    const t = window.setInterval(s.reload, 2000);
    return () => window.clearInterval(t);
  }, [running, s.reload]);
  // Files are in the bucket (or on their way): it cannot be changed or removed.
  const locked = Boolean(d && (d.storage === 'b2' || d.bothInUse));
  const move = (to: 'b2' | 'local', question: string): void => {
    if (window.confirm(question)) {
      void act('/v1/settings/storage/move', { method: 'POST', body: { to } });
    }
  };
  return (
    <Card title="Storage">
      <Status load={s} what="the storage settings" />
      <Problem text={error} />
      {d && (
        <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
          <p style={{ margin: 0 }}>
            Shared files and client uploads are stored <strong>{PLACE[d.storage]}</strong>
            {d.bothInUse && !running
              ? ', and some still in the other place: move again to finish'
              : ''}
            . They are encrypted with the firm key before they are stored, wherever that is. Keep
            the appliance backup of the firm key: without it no file can be opened.
          </p>
          {d.move && (
            <p role="status" style={{ margin: 0 }}>
              {d.move.state === 'requested' &&
                `Moving ${PLACE[d.move.to]}: ${d.move.attempts ? 'starting again after a restart' : 'starting'}…`}
              {d.move.state === 'running' &&
                `Moving ${PLACE[d.move.to]}: ${d.move.copied ?? 0} of ${d.move.total ?? '…'} files checked.`}
              {d.move.state === 'done' &&
                `Moved ${PLACE[d.move.to]} ${when(d.move.finishedAt ?? null)} (${d.move.total ?? 0} files), asked by ${d.move.by}.`}
              {d.move.state === 'failed' &&
                `The move ${PLACE[d.move.to]} stopped: ${d.move.error ?? 'unknown'}. Nothing is lost; move again to finish.`}
              {d.move.state === 'interrupted' &&
                `The move ${PLACE[d.move.to]} was cut off by restarts ${d.move.attempts ?? 1} times, so it no longer starts again by itself. Nothing is lost; move again to finish.`}
            </p>
          )}
          {d.note?.refused && (
            <p role="alert" style={{ margin: 0 }}>
              The daily check found {d.note.refused.count} of {d.note.refused.total} stored files
              named by no file or upload, too many to be leftovers, so none was deleted. This
              happens when the database is older than the files (a backup restored): ask for help
              before moving files.
            </p>
          )}
          {d.note?.otherBucket && (
            <p role="alert" style={{ margin: 0 }}>
              The bucket carries another portal&rsquo;s mark, so the daily check for leftover files
              does not run on it.
            </p>
          )}
          {d.storage === 'b2' && (
            <div style={{ display: 'grid', gap: 4 }}>
              <span>
                A copy of the portal&rsquo;s database, encrypted, goes to the bucket every hour:
                with the appliance&rsquo;s firm key file it is enough to get every file back.{' '}
                {d.note?.snapshotAt
                  ? `Last sent ${when(d.note.snapshotAt)}.`
                  : 'None has been sent yet.'}
              </span>
              {d.note?.snapshotError && (
                <span role="alert">The last one failed: {d.note.snapshotError}</span>
              )}
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy || running}
                  onClick={() => void act('/v1/settings/storage/snapshot', { method: 'POST' })}
                >
                  Send a database copy now
                </Button>
              </div>
            </div>
          )}
          <form
            style={{ display: 'grid', gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault();
              setTested(false);
              const { appKey, ...rest } = b2;
              void act('/v1/settings/storage/b2', {
                method: 'PUT',
                body: appKey ? { ...rest, appKey } : rest,
              }).then((r) => {
                if (r) setB2((v) => ({ ...v, appKey: '' }));
              });
            }}
          >
            <strong>Backblaze B2 bucket</strong>
            <span style={{ fontSize: 13 }}>
              Use a bucket for the portal alone, and an application key limited to it that may read,
              write, list and delete files. Saving checks the bucket with a small test file first.
            </span>
            <Input
              label="Endpoint (on the bucket's page, e.g. s3.us-west-004.backblazeb2.com)"
              name="b2Endpoint"
              value={b2.endpoint}
              disabled={locked}
              onChange={(e) => setB2({ ...b2, endpoint: e.target.value })}
            />
            <Input
              label="Bucket name"
              name="b2Bucket"
              value={b2.bucket}
              disabled={locked}
              onChange={(e) => setB2({ ...b2, bucket: e.target.value })}
            />
            <Input
              label="Key ID"
              name="b2KeyId"
              value={b2.keyId}
              onChange={(e) => setB2({ ...b2, keyId: e.target.value })}
            />
            <Input
              label={
                d.b2.hasKey
                  ? 'Application key (leave empty to keep the saved one)'
                  : 'Application key'
              }
              name="b2AppKey"
              type="password"
              autoComplete="off"
              value={b2.appKey}
              onChange={(e) => setB2({ ...b2, appKey: e.target.value })}
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button type="submit" disabled={busy || running}>
                Check and save
              </Button>
              {d.b2.hasKey && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setTested(false);
                    void act('/v1/settings/storage/test', { method: 'POST' }).then((r) => {
                      if (r) setTested(true);
                    });
                  }}
                >
                  Test
                </Button>
              )}
              {d.b2.hasKey && !locked && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void act('/v1/settings/storage/b2', { method: 'DELETE' })}
                >
                  Remove bucket
                </Button>
              )}
            </div>
            {tested && <p role="status">The bucket works with the saved key.</p>}
          </form>
          {d.b2.hasKey && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(d.storage !== 'b2' || d.bothInUse) && (
                <Button
                  disabled={busy || running}
                  onClick={() =>
                    move(
                      'b2',
                      'Move every stored file to the B2 bucket? The portal keeps working while it runs. Files are deleted from the appliance only once all of them are in the bucket.',
                    )
                  }
                >
                  Move files to B2
                </Button>
              )}
              {(d.storage !== 'local' || d.bothInUse) && (
                <Button
                  variant="secondary"
                  disabled={busy || running}
                  onClick={() =>
                    move(
                      'local',
                      'Move every stored file back to the appliance? Check it has room for them first. Files are deleted from the bucket only once all of them are on the appliance.',
                    )
                  }
                >
                  Move files back to the appliance
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** What a staff member may do: admin or not, and every client or only some (P48). */
function StaffAccess({
  who,
  clients,
  busy,
  error,
  onSave,
  onCancel,
}: {
  who: StaffRow;
  clients: Load<{ clients: ClientRow[] }>;
  busy: boolean;
  /** Why the last save did not work: shown here, by the button, as well as at the top. */
  error: string;
  onSave: (change: { admin: boolean; clientIds: string[] | null }) => void;
  onCancel: () => void;
}): JSX.Element {
  const [admin, setAdmin] = useState(who.admin);
  const [limited, setLimited] = useState(who.clientIds !== null);
  const [picked, setPicked] = useState<Set<string>>(new Set(who.clientIds ?? []));
  const [q, setQ] = useState('');
  const all = clients.data?.clients ?? [];
  const shown = all.filter((c) =>
    `${c.displayName} ${c.clientCode}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const some = limited && !admin;
  return (
    <form
      aria-label={`Access for ${who.name}`}
      style={{
        display: 'grid',
        gap: 8,
        margin: '12px 0',
        padding: 12,
        border: '1px solid var(--vibe-border, #ddd)',
        borderRadius: 6,
      }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ admin, clientIds: some ? [...picked] : null });
      }}
    >
      <strong>
        Access for {who.name} ({who.email})
      </strong>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
        <span>Admin: uses Settings (the firm, portal keys, staff) and sees every client</span>
      </label>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="radio"
          name="sees"
          checked={!some}
          disabled={admin}
          onChange={() => setLimited(false)}
        />
        <span>Sees every client</span>
      </label>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="radio"
          name="sees"
          checked={some}
          disabled={admin}
          onChange={() => setLimited(true)}
        />
        <span>Sees only these clients</span>
      </label>
      {some && (
        <>
          <p>
            They see the people, files, uploads and history of these clients, and nothing of any
            other client. They do not see access requests.
          </p>
          <Status load={clients} what="the clients" />
          <Input
            label="Find a client to tick"
            name="accessFind"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div style={{ maxHeight: 260, overflowY: 'auto', display: 'grid', gap: 4 }}>
            {shown.map((c) => (
              <label key={c.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={picked.has(c.id)}
                  onChange={(e) => toggle(c.id, e.target.checked)}
                />
                <span>
                  {c.displayName} {c.clientCode && `(${c.clientCode})`}
                  {!c.active && ' (switched off)'}
                </span>
              </label>
            ))}
            {clients.data && shown.length === 0 && (
              <span>{q.trim() ? 'No client matches.' : 'No clients on the portal yet.'}</span>
            )}
          </div>
          <span>
            {picked.size} {picked.size === 1 ? 'client' : 'clients'} ticked
            {picked.size === 0 && ': they will see no clients'}
          </span>
        </>
      )}
      {error && <span>{error}</span>}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="submit" disabled={busy}>
          Save access
        </Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
