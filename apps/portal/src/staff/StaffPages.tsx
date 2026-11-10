// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The staff page (D13): clients and their people and files, access requests, client uploads,
// the history, and Settings (P36). Sharing new files stays in Vibe Files.

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, Input } from '@vibe/ui';

import { ApiError } from '../api';
import {
  staffApi,
  staffSay,
  when,
  type ClientRow,
  type Invitation,
  type PortalUser,
  type SharedFile,
  type StaffMe,
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

/** Settings tells the header to read the firm name again. */
const ME_CHANGED = 'vibe-staff-me-changed';

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
  const nav = ['Clients', 'Requests', 'Uploads', 'History', 'Settings'];
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: 16, display: 'grid', gap: 16 }}>
      <header style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
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
        <Route index element={<Clients />} />
        <Route path="clients/:id" element={<ClientDetail />} />
        <Route path="requests" element={<Requests />} />
        <Route path="uploads" element={<Uploads />} />
        <Route path="history" element={<History />} />
        <Route path="settings" element={<Settings />} />
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

function Clients(): JSX.Element {
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
      <Input label="Find a client" name="q" value={q} onChange={(e) => setQ(e.target.value)} />
      <Status load={load} what="the clients" />
      {load.data && rows.length === 0 && (
        <p>{q.trim() ? 'No client matches.' : 'No clients on the portal yet.'}</p>
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
  const reload = (): void => {
    people.reload();
    files.reload();
  };
  const { act, busy, error } = useAct(reload);
  const [inv, setInv] = useState({ email: '', phone: '', name: '', roleLabel: '' });
  const label = (u: PortalUser): string => u.name || u.email || u.phone || '?';
  const invite = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(inv).filter(([, v]) => v.trim() !== ''));
    if (await act(`/v1/clients/${id}/invites`, { body })) {
      setInv({ email: '', phone: '', name: '', roleLabel: '' });
    }
  };
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Link to="/staff">← All clients</Link>
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
          <Button type="submit" disabled={busy || !(inv.email.trim() || inv.phone.trim())}>
            Send invitation
          </Button>
        </form>
      </Card>
      <Card title="Files on the portal">
        <Status load={files} what="the files" />
        {files.data?.files.length === 0 && <p>No files on the portal for this client.</p>}
        <Table head={['File', 'Shared', 'Who sees it', 'Actions']}>
          {(files.data?.files ?? []).map((f) => (
            <tr key={f.fileId}>
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
                    const u = people.data?.users.find((p) => p.identityId === x.identityId);
                    return (
                      <span
                        key={x.identityId}
                        style={{ display: 'inline-flex', gap: 4, marginRight: 8 }}
                      >
                        {u ? label(u) : 'someone'} (
                        {x.viewedAt ? `opened ${when(x.viewedAt)}` : 'not opened'})
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
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
                  variant="danger"
                  disabled={busy}
                  aria-label={`Remove ${f.name}`}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Remove ${f.name} from the portal for everyone? The cabinet keeps it.`,
                      )
                    ) {
                      void act(`/v1/files/${f.fileId}`, { method: 'DELETE' });
                    }
                  }}
                >
                  Remove
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
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
        The newest 300 events: sign-ins, invitations, sharing, client views and downloads, uploads.
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
  const staff = useLoad<{
    staff: {
      id: string;
      email: string;
      name: string;
      active: boolean;
      ready: boolean;
      lastSignInAt: string | null;
    }[];
  }>('/v1/staff');
  const me = useLoad<StaffMe>('/auth/me');
  const reload = (): void => {
    s.reload();
    keys.reload();
    staff.reload();
  };
  const { act: run, busy, error } = useAct(reload);
  const [form, setForm] = useState<SettingsData | null>(null);
  const [newKey, setNewKey] = useState('');
  const [keyLabel, setKeyLabel] = useState('');
  const [person, setPerson] = useState({ email: '', name: '' });
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
                      if (r) setLogoV((v) => v + 1);
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
                  void act('/v1/settings/logo', { method: 'DELETE' }).then(() =>
                    setLogoV((v) => v + 1),
                  )
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
        <Table head={['Name', 'Email', 'State', 'Last sign-in', 'Actions']}>
          {(staff.data?.staff ?? []).map((u) => {
            const self = u.email === me.data?.email;
            return (
              <tr key={u.id}>
                <td style={td}>{u.name}</td>
                <td style={td}>{u.email}</td>
                <td style={td}>
                  {self ? 'you' : !u.active ? 'turned off' : u.ready ? 'active' : 'setting up'}
                </td>
                <td style={td}>{when(u.lastSignInAt)}</td>
                <td style={td}>
                  {!self && (
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
                  {!self && u.active && (
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
        <form
          style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void act('/v1/staff', { body: person }).then((r) => {
              const l = (r as { setupLink?: string } | null)?.setupLink;
              if (l) {
                setLink({ who: `${person.name} (${person.email.trim()})`, url: l });
                setPerson({ email: '', name: '' });
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
    </div>
  );
}
