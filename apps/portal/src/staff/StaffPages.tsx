// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The staff page (D13): clients and their people and files, access requests, client uploads,
// the history, and Settings (P36). Sharing new files stays in Vibe Files; sending a file that
// is already here to someone outside the client, by a secure link, is done here (P49).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Card,
  CloseIcon,
  Input,
  MenuIcon,
  ShareIcon,
  tokens,
  Trash,
  useIsNarrow,
  ThemeToggle,
} from '@vibe/ui';

import { FirmLogo, reloadBranding } from '../branding';
import { Select } from '../components/Field';
import { AuthSettingsPage } from '@kisaesdevlab/vibe-auth/react';
import { usePages } from '../paging';
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
  // P59: on a phone the menu folds behind a button.
  const narrow = useIsNarrow();
  const [menuOpen, setMenuOpen] = useState(false);
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
    // P44: signed in through Vibe Auth, signed out there too (it ends this session, then
    // Vibe Auth's own, and comes back to the sign-in page).
    if (me.data?.sso) {
      window.location.assign('/api/staff/sso/auth/oidc/logout');
      return;
    }
    await staffApi('/auth/logout', { method: 'POST' }).catch(() => undefined);
    navigate('/staff/login', { replace: true });
  };
  // Settings are for admins; access requests for staff who see every client.
  const { admin, allClients } = me.data;
  const nav = [
    'Clients',
    ...(allClients ? ['Requests', 'People'] : []),
    'Uploads',
    'History',
    ...(admin ? ['Settings', 'Log'] : []),
  ];
  const links = nav.map((n) => (
    <NavLink
      key={n}
      to={n === 'Clients' ? '/staff' : `/staff/${n.toLowerCase()}`}
      end={n === 'Clients' || n === 'People' ? false : true}
      onClick={() => setMenuOpen(false)}
      style={({ isActive }) => ({
        padding: narrow ? '12px 12px' : '8px 12px',
        borderRadius: tokens.radius.md,
        textDecoration: 'none',
        fontWeight: 500,
        color: isActive ? 'var(--vibe-on-accent, #fff)' : tokens.color.text,
        background: isActive ? tokens.color.accent : 'transparent',
      })}
    >
      {n}
    </NavLink>
  ));
  return (
    <div
      style={{
        maxWidth: 1100,
        margin: '0 auto',
        padding: narrow ? 12 : 16,
        display: 'grid',
        gap: 16,
      }}
    >
      <header
        style={{
          display: 'grid',
          gap: 8,
          padding: '8px 0 12px',
          borderBottom: `1px solid ${tokens.color.border}`,
        }}
      >
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <FirmLogo height={32} />
          <strong style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            {me.data.firmName}
            {!narrow && ' · portal staff'}
          </strong>
          {!narrow && (
            <nav aria-label="Staff" style={{ display: 'flex', gap: 4, marginLeft: 16 }}>
              {links}
            </nav>
          )}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            {!narrow && <span>{me.data.name}</span>}
            {/* Light or dark, remembered in this browser (the device's setting until chosen). */}
            <ThemeToggle />
            {narrow ? (
              <Button
                size="sm"
                variant="secondary"
                aria-expanded={menuOpen}
                aria-label="Menu"
                onClick={() => setMenuOpen((o) => !o)}
              >
                {menuOpen ? <CloseIcon size={18} /> : <MenuIcon size={18} />}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => void signOut()}>
                Sign out
              </Button>
            )}
          </span>
        </div>
        {narrow && menuOpen && (
          <nav aria-label="Staff" style={{ display: 'grid', gap: 2 }}>
            {links}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '8px 12px',
                borderTop: `1px solid ${tokens.color.border}`,
              }}
            >
              <span>{me.data.name}</span>
              <Button size="sm" variant="secondary" onClick={() => void signOut()}>
                Sign out
              </Button>
            </div>
          </nav>
        )}
      </header>
      <Routes>
        <Route index element={<Clients limited={!allClients} />} />
        <Route path="clients/:id" element={<ClientDetail allClients={allClients} />} />
        {allClients && <Route path="requests" element={<Requests />} />}
        {allClients && <Route path="people" element={<People />} />}
        {allClients && <Route path="people/:identityId" element={<Person />} />}
        <Route path="uploads" element={<Uploads />} />
        <Route path="history" element={<History />} />
        {admin && <Route path="settings" element={<Settings />} />}
        {admin && <Route path="log" element={<Log />} />}
        <Route path="*" element={<Navigate to="/staff" replace />} />
      </Routes>
    </div>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLTableElement>(null);
  // P59: each cell carries its column's name, shown beside it when the row is a card. Only on
  // a phone, where the cards are.
  const narrowTable = useIsNarrow();
  useLayoutEffect(() => {
    if (!narrowTable) return;
    const rows = ref.current?.tBodies[0]?.rows ?? [];
    for (const tr of Array.from(rows)) {
      Array.from(tr.cells).forEach((td, i) => {
        td.dataset['label'] = head[i] ?? '';
        if (i === 0 || (i === 1 && head[0] === '')) td.dataset['first'] = '1';
      });
    }
  });
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        ref={ref}
        className="staff-table"
        style={{ width: '100%', borderCollapse: 'collapse' }}
      >
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={`${i}-${h}`}
                style={{
                  textAlign: 'left',
                  padding: '8px',
                  fontSize: 12,
                  fontWeight: 600,
                  color: tokens.color.textMuted,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
              >
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

const td = { padding: '6px 8px', borderTop: '1px solid var(--vibe-color-border)' };

function Clients({ limited }: { limited: boolean }): JSX.Element {
  const load = useLoad<{ clients: ClientRow[] }>('/v1/clients');
  const [q, setQ] = useState('');
  const rows = (load.data?.clients ?? []).filter((c) =>
    `${c.displayName} ${c.clientCode}`.toLowerCase().includes(q.trim().toLowerCase()),
  );
  const { slice, pager } = usePages(rows, `${q}|${rows.length}`);
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
        {slice.map((c) => (
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
      {pager}
    </Card>
  );
}

function ClientDetail({ allClients }: { allClients: boolean }): JSX.Element {
  const { id = '' } = useParams();
  const people = useLoad<{ users: PortalUser[]; invitations: Invitation[] }>(
    `/v1/clients/${id}/users`,
  );
  const files = useLoad<{ files: SharedFile[] }>(`/v1/files?clientId=${id}`);
  const links = useLoad<{ shares: OutsideShare[] }>(`/v1/shares?clientId=${id}`);
  const history = useLoad<{ events: ClientEvent[] }>(
    `/v1/clients/${id}/history?limit=${CLIENT_HISTORY_PAGE}`,
  );
  const reload = (): void => {
    history.reload();
    people.reload();
    files.reload();
    links.reload();
    head.reload();
    uploads.reload();
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
              <td style={td}>
                {allClients ? (
                  <Link to={`/staff/people/${u.identityId}`}>{label(u)}</Link>
                ) : (
                  label(u)
                )}
                <ClientTags
                  label={`Clients ${label(u)} can see`}
                  tags={(u.clients ?? []).map((c) => ({
                    id: c.id,
                    content:
                      c.id === id ? c.name : <Link to={`/staff/clients/${c.id}`}>{c.name}</Link>,
                  }))}
                />
              </td>
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
          // A file removed leaves the links that held it.
          links.reload();
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
        onResend={(s) => {
          if (
            window.confirm(
              `Send ${s.email} a new link to the same files? The link they have now stops working.`,
            )
          ) {
            setSentNote('');
            void act(`/v1/shares/${s.id}/resend`, { method: 'POST' }).then((r) => {
              if (r) setSentNote(`A new link was sent to ${s.email}.`);
            });
          }
        }}
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
      <HistoryCard
        title="History"
        path={`/v1/clients/${id}/history`}
        empty="Nothing has happened on this client yet."
        load={history}
      />
    </div>
  );
}

interface ClientEvent {
  id: number;
  at: string;
  kind: string;
  who: string;
  person: string | null;
  file: string | null;
  recipient: string | null;
  /** The client it was on (P66). */
  client?: string | null;
}

const CLIENT_HISTORY_PAGE = 50;

/** What each kind of event says on a client's History (P65). */
const DID: Record<string, string> = {
  share: 'Shared a file',
  unshare: 'Stopped sharing a file',
  remove: 'Removed a file',
  replace: 'Replaced a file',
  file_added: 'Added a file',
  view: 'Viewed a file',
  download: 'Downloaded a file',
  upload: 'Uploaded a file',
  upload_notice: 'Upload notice sent',
  fetch: 'Fetched an upload',
  upload_removed: 'Removed an upload',
  upload_purged: 'Upload cleared after the keep period',
  invite: 'Invited someone',
  invite_revoked: 'Withdrew an invitation',
  invite_accepted: 'Accepted an invitation',
  request: 'Asked for access',
  request_confirmed: 'Confirmed an access request',
  approve: 'Approved access',
  deny: 'Denied access',
  disable: 'Turned off someone',
  enable: 'Turned on someone',
  sign_in: 'Signed in',
  sign_out: 'Signed out',
  phone_added: 'Added a mobile number',
  phone_removed: 'Removed a mobile number',
  client_updated: 'Client details updated',
  outside_share: 'Sent a secure link',
  outside_share_revoked: 'Revoked a secure link',
  outside_code_sent: 'Secure link code sent',
  outside_verified: 'Secure link opened',
  outside_view: 'Viewed by secure link',
  outside_download: 'Downloaded by secure link',
  outside_locked: 'Secure link locked after wrong codes',
  outside_share_resent: 'Sent a secure link again',
  account_off: 'Account turned off',
  account_on: 'Account turned on',
  person_updated: 'Details changed',
  contact_change_sent: 'Asked to confirm a new email or number',
  contact_changed: 'Confirmed a new email or number',
  client_added: 'Client added',
  sign_in_link_sent: 'Sign-in link sent',
  id_viewed: 'Looked at a photo ID',
};

/** What happened on one client (P65), or what one person did and had done (P66), newest first. */
function HistoryCard({
  title,
  path,
  empty,
  load,
  showClient = false,
}: {
  title: string;
  /** The API path without its query. */
  path: string;
  empty: string;
  load: Load<{ events: ClientEvent[] }>;
  showClient?: boolean;
}): JSX.Element {
  const [older, setOlder] = useState<ClientEvent[]>([]);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const first = load.data?.events ?? [];
  useEffect(() => {
    setOlder([]);
    setMore(first.length === CLIENT_HISTORY_PAGE);
  }, [load.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = [...first, ...older];
  const showOlder = async (): Promise<void> => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setBusy(true);
    setProblem('');
    try {
      const r = await staffApi<{ events: ClientEvent[] }>(
        `${path}?limit=${CLIENT_HISTORY_PAGE}&before=${last.id}`,
      );
      setOlder((o) => [...o, ...r.events]);
      setMore(r.events.length === CLIENT_HISTORY_PAGE);
    } catch (err) {
      setProblem(staffSay(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={title}>
      <Status load={load} what={title.toLowerCase()} />
      <Problem text={problem} />
      {load.data && rows.length === 0 && <p>{empty}</p>}
      <Table
        head={
          showClient ? ['When', 'What', 'Who', 'Client', 'About'] : ['When', 'What', 'Who', 'About']
        }
      >
        {rows.map((e) => (
          <tr key={e.id}>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{when(e.at)}</td>
            <td style={td}>{DID[e.kind] ?? e.kind.replace(/_/g, ' ')}</td>
            <td style={td}>{e.who}</td>
            {showClient && <td style={td}>{e.client ?? ''}</td>}
            <td style={{ ...td, overflowWrap: 'anywhere' }}>
              {[
                e.file,
                e.person && e.person !== e.who ? e.person : null,
                e.recipient && `to ${e.recipient}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </td>
          </tr>
        ))}
      </Table>
      {load.data && more && (
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" disabled={busy} onClick={() => void showOlder()}>
            Show older
          </Button>
        </div>
      )}
    </Card>
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
  const { slice: page, pager } = usePages(shown, `${q}|${year}|${sort}|${shown.length}`);
  const folders = years
    .map((y) => ({ year: y, files: page.filter((f) => f.taxYear === y) }))
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

  /** One call per file, four at a time; the list is read again once at the end. A file that
   *  failed stays selected, and the page says how many, so trying again finishes the job. */
  const many = async (what: (f: SharedFile) => Promise<unknown>): Promise<void> => {
    setWorking(true);
    setProblem('');
    const failed = new Set<string>();
    let why = '';
    const queue = [...pickedFiles];
    const worker = async (): Promise<void> => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          await what(f);
        } catch (err) {
          failed.add(f.fileId);
          why = staffSay(err);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setPicked(failed);
    if (failed.size) {
      setProblem(
        `${failed.size} of ${pickedFiles.length} could not be changed (${why}). They are still selected: try again.`,
      );
    }
    setWorking(false);
    onChanged();
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
        <div style={{ fontWeight: 500, overflowWrap: 'anywhere' }}>{f.name}</div>
        <small style={{ color: tokens.color.textMuted }}>
          {f.contentUpdatedAt
            ? `Updated ${when(f.contentUpdatedAt)}`
            : `Shared ${when(f.sharedAt)} by ${f.sharedBy}`}
        </small>
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
                  variant="secondary"
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
          style={{ marginRight: 6, marginBottom: 4 }}
          onClick={() => onSend(f.fileId)}
        >
          <ShareIcon size={16} />
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
          <Trash size={16} />
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
          <div style={{ flex: '0 1 150px' }}>
            <Select label="Tax year" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="all">All years</option>
              {years.map((y) => (
                <option key={y ?? 'none'} value={String(y ?? 'none')}>
                  {y ?? 'No tax year'}
                </option>
              ))}
            </Select>
          </div>
          <div style={{ flex: '0 1 150px' }}>
            <Select label="Sort" value={sort} onChange={(e) => setSort(e.target.value as FileSort)}>
              <option value="newest">Newest first</option>
              <option value="name">Name</option>
              <option value="year">Tax year</option>
            </Select>
          </div>
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
            <Table head={['', 'File', 'Who sees it', 'Actions']}>{g.files.map(row)}</Table>
          </details>
        );
      })}
      {pager}
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
            <option value={14}>14 days</option>
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
  onResend,
  onRevoke,
}: {
  load: Load<{ shares: OutsideShare[] }>;
  busy: boolean;
  /** Sends a new link to the same files (P66). */
  onResend: (share: OutsideShare) => void;
  onRevoke: (share: OutsideShare) => void;
}): JSX.Element {
  const shares = load.data?.shares ?? [];
  const { slice, pager } = usePages(shares);
  return (
    <Card title="Secure links sent outside">
      <Status load={load} what="the secure links" />
      {load.data && shares.length === 0 && (
        <p>None yet. Use &ldquo;Send securely&rdquo; beside a file above.</p>
      )}
      {shares.length > 0 && (
        <Table head={['To', 'Files', 'Access', 'State', 'Sent', 'Expires', 'Opened', 'Actions']}>
          {slice.map((s) => (
            <tr key={s.id}>
              <td style={td}>
                {s.name ? `${s.name} (${s.email})` : s.email}
                {s.organization && `, ${s.organization}`}
              </td>
              <td style={td}>
                {s.files
                  .map(
                    (f) =>
                      `${f.name}${f.removed ? ' (removed)' : ''}${
                        s.canDownload
                          ? s.downloadLimit > 0
                            ? ` (${f.downloads ?? 0} of ${s.downloadLimit} downloads)`
                            : ` (${f.downloads ?? 0} ${f.downloads === 1 ? 'download' : 'downloads'})`
                          : ''
                      }`,
                  )
                  .join(', ')}
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
                {s.byClient && ' (the client)'}
              </td>
              <td style={td}>{when(s.expiresAt)}</td>
              <td style={td}>
                {s.opens === 0
                  ? '—'
                  : `${s.opens} ${s.opens === 1 ? 'time' : 'times'}, last ${when(s.lastOpenedAt)}`}
              </td>
              <td style={td}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(s.status === 'sent' || s.status === 'opened' || s.status === 'locked') && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      aria-label={`Resend the link to ${s.email}`}
                      onClick={() => onResend(s)}
                    >
                      Resend
                    </Button>
                  )}
                  {(s.status === 'sent' || s.status === 'opened') && (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={busy}
                      aria-label={`Revoke the link sent to ${s.email}`}
                      onClick={() => onRevoke(s)}
                    >
                      <CloseIcon size={16} />
                      Revoke
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {pager}
    </Card>
  );
}

/** Small tags in a row: "Client 1, Client 2, Client 3" under a person (P62). */
const tagStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  fontSize: 12,
  lineHeight: '18px',
  padding: '0 8px',
  borderRadius: 999,
  border: '1px solid var(--vibe-color-border)',
  background: 'var(--vibe-color-surface)',
  whiteSpace: 'nowrap',
} as const;

function ClientTags({
  label,
  tags,
}: {
  label: string;
  tags: { id: string; content: ReactNode }[];
}): JSX.Element | null {
  if (tags.length === 0) return null;
  return (
    <ul
      aria-label={label}
      style={{
        listStyle: 'none',
        margin: '4px 0 0',
        padding: 0,
        display: 'flex',
        gap: 4,
        flexWrap: 'wrap',
      }}
    >
      {tags.map((t) => (
        <li key={t.id} style={tagStyle}>
          {t.content}
        </li>
      ))}
    </ul>
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
  /** P67: the photo ID sent with it. */
  idPhoto?: { contentType: string | null; size: number | null } | null;
}

/** The photo ID of an access request (P67): the picture, or a link to the PDF. */
function IdPhoto({ r }: { r: AccessRequestRow }): JSX.Element {
  const src = `/api/staff/v1/access-requests/${r.id}/id-photo`;
  if (!r.idPhoto) return <span>No photo ID was sent.</span>;
  if (r.idPhoto.contentType === 'application/pdf') {
    return (
      <a href={src} target="_blank" rel="noreferrer">
        Open the photo ID (PDF)
      </a>
    );
  }
  return (
    <a href={src} target="_blank" rel="noreferrer" title="Open the photo ID full size">
      <img
        src={src}
        alt={`Photo ID sent by ${r.name}`}
        style={{
          maxWidth: 320,
          maxHeight: 220,
          objectFit: 'contain',
          border: '1px solid var(--vibe-color-border)',
          borderRadius: 6,
          display: 'block',
        }}
      />
    </a>
  );
}

function Requests(): JSX.Element {
  const reqs = useLoad<{ requests: AccessRequestRow[] }>('/v1/access-requests');
  const clients = useLoad<{ clients: ClientRow[] }>('/v1/clients');
  const [recordNote, setRecordNote] = useState('');
  const { act, busy, error } = useAct(reqs.reload);
  // P61: the clients chosen for each request (one or more).
  const [pick, setPick] = useState<Record<string, { clients: string[]; role: string }>>({});
  const active = (clients.data?.clients ?? []).filter((c) => c.active);
  const nameOf = (id: string): string => {
    const c = active.find((x) => x.id === id);
    return c ? `${c.displayName}${c.clientCode ? ` (${c.clientCode})` : ''}` : id;
  };
  return (
    <Card title="Access requests">
      <p>
        People who asked for access and confirmed their email or phone. Only the confirmed contact
        is used.
      </p>
      <Problem text={error} />
      {recordNote && <p role="status">{recordNote}</p>}
      <Status load={reqs} what="the requests" />
      <Status load={clients} what="the clients" />
      {reqs.data?.requests.length === 0 && <p>No requests waiting.</p>}
      {(reqs.data?.requests ?? []).map((r) => {
        const p = pick[r.id] ?? { clients: [], role: '' };
        const set = (v: Partial<typeof p>): void => setPick({ ...pick, [r.id]: { ...p, ...v } });
        return (
          <div
            key={r.id}
            style={{
              borderTop: '1px solid var(--vibe-color-border)',
              padding: '8px 0',
              display: 'grid',
              gap: 6,
            }}
          >
            <strong>{r.name}</strong>
            <ClientTags
              label={`Clients for ${r.name}`}
              tags={p.clients.map((cid) => ({
                id: cid,
                content: (
                  <>
                    {nameOf(cid)}
                    <button
                      type="button"
                      aria-label={`Remove ${nameOf(cid)} for ${r.name}`}
                      onClick={() => set({ clients: p.clients.filter((x) => x !== cid) })}
                      style={{
                        border: 0,
                        background: 'none',
                        color: 'inherit',
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '0 0 0 2px',
                        lineHeight: 1,
                      }}
                    >
                      ×
                    </button>
                  </>
                ),
              }))}
            />
            <span>
              Confirmed: {r.confirmedContact} · asked for “{r.clientAs}” · {when(r.createdAt)}
            </span>
            <IdPhoto r={r} />
            {r.note && <span>“{r.note}”</span>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span>
                  {p.clients.length ? 'Add another client' : 'Client'} for {r.name}
                </span>
                <select
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id && !p.clients.includes(id)) set({ clients: [...p.clients, id] });
                  }}
                >
                  <option value="">Choose…</option>
                  {active
                    .filter((c) => !p.clients.includes(c.id))
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
                disabled={busy || p.clients.length === 0}
                aria-label={`Approve ${r.name}`}
                onClick={() => {
                  setRecordNote('');
                  void act(`/v1/access-requests/${r.id}/approve`, {
                    body: { clientIds: p.clients, roleLabel: p.role },
                  }).then((res) => {
                    // P67: the PDF for Vibe Files could not be made yet (the Log says why).
                    if (res && (res as { recorded?: boolean }).recorded === false) {
                      setRecordNote(
                        `${r.name} was approved, but the PDF of the request and photo ID could not be made yet. The portal tries again every hour; Log says why.`,
                      );
                    }
                  });
                }}
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
  const { slice, pager } = usePages(data?.uploads ?? []);
  return (
    <Card title="Uploads waiting for Vibe Files">
      <p>
        What clients sent that Vibe Files has not collected yet. Downloading here does not take it
        out of Intake: Vibe Files still files it.
      </p>
      <Status load={load} what="the uploads" />
      {data?.uploads.length === 0 && <p>Nothing waiting: Vibe Files has collected everything.</p>}
      <Table head={['Received', 'Client', 'File', 'From', 'Note']}>
        {slice.map((u) => (
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
      {pager}
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

const HISTORY_PAGE = 100;

function History(): JSX.Element {
  const load = useLoad<{ events: EventRow[] }>(`/v1/events?latest=1&limit=${HISTORY_PAGE}`);
  // Older pages, fetched as asked for (P57).
  const [older, setOlder] = useState<EventRow[]>([]);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const first = load.data?.events ?? [];
  useEffect(() => {
    setOlder([]);
    setMore(first.length === HISTORY_PAGE);
  }, [load.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = [...first, ...older];
  const showOlder = async (): Promise<void> => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setBusy(true);
    setProblem('');
    try {
      const r = await staffApi<{ events: EventRow[] }>(
        `/v1/events?latest=1&limit=${HISTORY_PAGE}&before=${last.id}`,
      );
      setOlder((o) => [...o, ...r.events]);
      setMore(r.events.length === HISTORY_PAGE);
    } catch (err) {
      setProblem(staffSay(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="History">
      <p>
        Newest first: sign-ins, invitations, sharing, client views and downloads, uploads, and
        secure links sent outside (&ldquo;outside&rdquo; events).
      </p>
      <Status load={load} what="the history" />
      <Problem text={problem} />
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
      {load.data && more && (
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" disabled={busy} onClick={() => void showOlder()}>
            Show older
          </Button>
        </div>
      )}
    </Card>
  );
}

interface ProblemRow {
  id: number;
  at: string;
  level: 'warning' | 'error';
  msg: string;
  detail: Record<string, string | number | boolean>;
}

/** The server's warnings and errors, newest first (P64, admins). */
function Log(): JSX.Element {
  const load = useLoad<{ problems: ProblemRow[] }>(`/v1/settings/log?limit=${HISTORY_PAGE}`);
  const [older, setOlder] = useState<ProblemRow[]>([]);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const first = load.data?.problems ?? [];
  useEffect(() => {
    setOlder([]);
    setMore(first.length === HISTORY_PAGE);
  }, [load.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const rows = [...first, ...older];
  const showOlder = async (): Promise<void> => {
    const last = rows[rows.length - 1];
    if (!last) return;
    setBusy(true);
    setProblem('');
    try {
      const r = await staffApi<{ problems: ProblemRow[] }>(
        `/v1/settings/log?limit=${HISTORY_PAGE}&before=${last.id}`,
      );
      setOlder((o) => [...o, ...r.problems]);
      setMore(r.problems.length === HISTORY_PAGE);
    } catch (err) {
      setProblem(staffSay(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Log">
      <p style={{ marginTop: 0 }}>
        Warnings and errors from the portal, newest first, kept 30 days: when something did not
        work, the reason is here. Who did what is on History.
      </p>
      <div style={{ marginBottom: 8 }}>
        <Button variant="secondary" size="sm" onClick={load.reload}>
          Refresh
        </Button>
      </div>
      <Status load={load} what="the log" />
      <Problem text={problem} />
      {load.data && rows.length === 0 && <p>No warnings or errors.</p>}
      <Table head={['When', 'Level', 'What']}>
        {rows.map((p) => (
          <tr key={p.id}>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{when(p.at)}</td>
            <td style={td}>{p.level === 'error' ? 'Error' : 'Warning'}</td>
            <td style={td}>
              {p.msg}
              {Object.keys(p.detail).length > 0 && (
                <div
                  style={{ fontSize: 12, color: tokens.color.textMuted, overflowWrap: 'anywhere' }}
                >
                  {Object.entries(p.detail)
                    .map(([k, v]) => `${k}: ${String(v)}`)
                    .join(' · ')}
                </div>
              )}
            </td>
          </tr>
        ))}
      </Table>
      {load.data && more && (
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" disabled={busy} onClick={() => void showOlder()}>
            Show older
          </Button>
        </div>
      )}
    </Card>
  );
}

interface PersonRow {
  identityId: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: 'active' | 'disabled';
  lastSignInAt: string | null;
  clients: { id: string; name: string }[];
}

const personLabel = (p: { name: string; email: string | null; phone: string | null }): string =>
  p.name || p.email || p.phone || '?';

/** Everyone on the portal, turned-off accounts too (P66). */
function People(): JSX.Element {
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setQ(typed.trim()), 300);
    return () => window.clearTimeout(t);
  }, [typed]);
  const path = `/v1/people/list?q=${encodeURIComponent(q)}`;
  const load = useLoad<{ people: PersonRow[]; more: boolean }>(path);
  const [later, setLater] = useState<PersonRow[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    setLater([]);
    setMore(load.data?.more ?? false);
  }, [load.data]);
  const rows = [...(load.data?.people ?? []), ...later];
  const showMore = async (): Promise<void> => {
    setBusy(true);
    setProblem('');
    try {
      const r = await staffApi<{ people: PersonRow[]; more: boolean }>(
        `${path}&offset=${rows.length}`,
      );
      setLater((l) => [...l, ...r.people]);
      setMore(r.more);
    } catch (err) {
      setProblem(staffSay(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="People">
      <p style={{ marginTop: 0 }}>
        Everyone who can sign in to the portal. Open a person to change their details, their clients
        or their account, send them a sign-in link, or see what they did.
      </p>
      <div style={{ maxWidth: 360, marginBottom: 8 }}>
        <Input
          label="Find a person (name, email or mobile number)"
          name="peopleFind"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      <Status load={load} what="the people" />
      <Problem text={problem} />
      {load.data && rows.length === 0 && (
        <p>{q ? 'Nobody matches.' : 'Nobody is on the portal yet.'}</p>
      )}
      <Table head={['Name', 'Email / phone', 'Clients', 'Last sign-in']}>
        {rows.map((p) => (
          <tr key={p.identityId}>
            <td style={td}>
              <Link to={`/staff/people/${p.identityId}`}>{personLabel(p)}</Link>
              {p.status === 'disabled' && (
                <span style={{ ...tagStyle, marginLeft: 6 }}>Turned off</span>
              )}
            </td>
            <td style={{ ...td, overflowWrap: 'anywhere' }}>
              {[p.email, p.phone].filter(Boolean).join(', ')}
            </td>
            <td style={td}>
              <ClientTags
                label={`Clients ${personLabel(p)} can see`}
                tags={p.clients.map((c) => ({
                  id: c.id,
                  content: <Link to={`/staff/clients/${c.id}`}>{c.name}</Link>,
                }))}
              />
            </td>
            <td style={td}>{when(p.lastSignInAt)}</td>
          </tr>
        ))}
      </Table>
      {more && (
        <div style={{ marginTop: 8 }}>
          <Button variant="secondary" disabled={busy} onClick={() => void showMore()}>
            Show more
          </Button>
        </div>
      )}
    </Card>
  );
}

interface PersonData {
  person: {
    identityId: string;
    name: string;
    email: string | null;
    phone: string | null;
    notify: 'email' | 'sms' | 'both' | 'none';
    status: 'active' | 'disabled';
    createdAt: string;
    lastSignInAt: string | null;
  };
  clients: {
    id: string;
    name: string;
    roleLabel: string;
    active: boolean;
    clientActive: boolean;
  }[];
  pendingContact: { contact: string; expiresAt: string } | null;
  textsOn: boolean;
}

const NOTIFY_WORDS = {
  email: 'By email',
  sms: 'By text',
  both: 'By email and text',
  none: 'Not at all',
} as const;

/** One person: details, clients, account and activity (P66). */
function Person(): JSX.Element {
  const { identityId = '' } = useParams();
  const load = useLoad<PersonData>(`/v1/people/${identityId}`);
  const history = useLoad<{ events: ClientEvent[] }>(
    `/v1/people/${identityId}/history?limit=${CLIENT_HISTORY_PAGE}`,
  );
  const all = useLoad<{ clients: ClientRow[] }>('/v1/clients');
  const reload = (): void => {
    load.reload();
    history.reload();
  };
  const { act, busy, error } = useAct(reload);
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [notify, setNotify] = useState<PersonData['person']['notify']>('email');
  const [changing, setChanging] = useState<'email' | 'phone' | null>(null);
  const [contact, setContact] = useState('');
  const [adding, setAdding] = useState({ clientId: '', roleLabel: '' });
  const d = load.data;
  // Only when what is saved changes: another action reloads the page and must not wipe edits.
  const savedName = d?.person.name;
  const savedNotify = d?.person.notify;
  useEffect(() => {
    if (savedName !== undefined) setName(savedName);
  }, [savedName]);
  useEffect(() => {
    if (savedNotify !== undefined) setNotify(savedNotify);
  }, [savedNotify]);
  if (!d) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <Link to="/staff/people">← All people</Link>
        <Card title="Person">
          <Status load={load} what="this person" />
        </Card>
      </div>
    );
  }
  const p = d.person;
  const off = p.status === 'disabled';
  const who = personLabel(p);
  const done = (r: unknown, text: string): void => {
    if (r) setNote(text);
  };
  const run = (path: string, init: { method?: string; body?: unknown }, text: string): void => {
    setNote('');
    void act(path, init).then((r) => done(r, text));
  };
  const has = new Set(d.clients.filter((c) => c.active).map((c) => c.id));
  const canAdd = (all.data?.clients ?? []).filter((c) => c.active && !has.has(c.id));
  const notifyOptions = (Object.keys(NOTIFY_WORDS) as (keyof typeof NOTIFY_WORDS)[]).filter(
    (k) =>
      k === 'none' ||
      k === p.notify ||
      ((k === 'email' || k === 'both' ? Boolean(p.email) : true) &&
        (k === 'sms' || k === 'both' ? Boolean(p.phone) && d.textsOn : true)),
  );
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <Link to="/staff/people">← All people</Link>
      <h2 style={{ margin: 0 }}>
        {who}
        {off && <span style={{ ...tagStyle, marginLeft: 8, fontWeight: 400 }}>Turned off</span>}
      </h2>
      <Problem text={error} />
      {note && <p role="status">{note}</p>}

      <Card title="Details">
        <form
          style={{ display: 'grid', gap: 8, maxWidth: 420 }}
          onSubmit={(e) => {
            e.preventDefault();
            run(
              `/v1/people/${p.identityId}`,
              { method: 'PATCH', body: { name, notify } },
              'Saved.',
            );
          }}
        >
          <Input
            label="Name"
            name="personName"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Select
            label="New files are announced"
            value={notify}
            onChange={(e) => setNotify(e.target.value as PersonData['person']['notify'])}
          >
            {notifyOptions.map((k) => (
              <option key={k} value={k}>
                {NOTIFY_WORDS[k]}
              </option>
            ))}
          </Select>
          <div>
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
        <div style={{ display: 'grid', gap: 8, marginTop: 16, maxWidth: 520 }}>
          <strong>Signs in with</strong>
          <span style={{ fontSize: 13 }}>
            A new email or number is used only once they open the link sent to it, so a mistyped one
            lets nobody in.
          </span>
          {(['email', 'phone'] as const).map((f) => (
            <div
              key={f}
              style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <span style={{ minWidth: 120 }}>{f === 'email' ? 'Email' : 'Mobile number'}</span>
              <span style={{ overflowWrap: 'anywhere' }}>{p[f] ?? 'None'}</span>
              {!off && (f === 'email' || d.textsOn) && changing !== f && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setChanging(f);
                    setContact('');
                  }}
                >
                  {p[f] ? 'Change' : 'Add'}
                </Button>
              )}
              {f === 'phone' && p.phone && p.email && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Remove ${p.phone}? They keep signing in by email.`)) {
                      run(
                        `/v1/people/${p.identityId}/phone`,
                        { method: 'DELETE' },
                        'Mobile number removed.',
                      );
                    }
                  }}
                >
                  Remove
                </Button>
              )}
            </div>
          ))}
          {changing && (
            <form
              style={{ display: 'grid', gap: 8 }}
              onSubmit={(e) => {
                e.preventDefault();
                setNote('');
                void act(`/v1/people/${p.identityId}/contact`, {
                  method: 'POST',
                  body: { [changing]: contact },
                }).then((r) => {
                  if (r) {
                    setNote(
                      `A link was sent to ${contact.trim()}. The change takes effect when they open it.`,
                    );
                    setChanging(null);
                  }
                });
              }}
            >
              {d.pendingContact && (
                <span style={{ fontSize: 13 }}>
                  This replaces the change waiting for {d.pendingContact.contact}.
                </span>
              )}
              <Input
                label={changing === 'email' ? 'New email' : 'New mobile number'}
                name="newContact"
                type={changing === 'email' ? 'email' : 'tel'}
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <Button type="submit" disabled={busy || !contact.trim()}>
                  Send confirmation link
                </Button>
                <Button type="button" variant="secondary" onClick={() => setChanging(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          )}
          {d.pendingContact && (
            <p role="status" style={{ margin: 0 }}>
              Waiting for {d.pendingContact.contact} to be confirmed (until{' '}
              {when(d.pendingContact.expiresAt)}).{' '}
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  run(
                    `/v1/people/${p.identityId}/contact`,
                    { method: 'DELETE' },
                    'The change was withdrawn.',
                  )
                }
              >
                Withdraw
              </Button>
            </p>
          )}
        </div>
      </Card>

      <Card title="Clients">
        {d.clients.length === 0 && <p>No clients.</p>}
        <Table head={['Client', 'Role', 'Access', 'Actions']}>
          {d.clients.map((c) => (
            <tr key={c.id}>
              <td style={td}>
                <Link to={`/staff/clients/${c.id}`}>{c.name}</Link>
                {!c.clientActive && ' (client switched off)'}
              </td>
              <td style={td}>{c.roleLabel}</td>
              <td style={td}>{c.active ? 'Can see it' : 'Removed'}</td>
              <td style={td}>
                {c.active && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    aria-label={`Remove ${c.name} for ${who}`}
                    onClick={() => {
                      if (
                        window.confirm(`Remove ${c.name} for ${who}? They stop seeing it at once.`)
                      ) {
                        run(
                          `/v1/people/${p.identityId}/clients/${c.id}`,
                          { method: 'DELETE' },
                          `${c.name} removed.`,
                        );
                      }
                    }}
                  >
                    Remove
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
        <form
          style={{ display: 'grid', gap: 8, maxWidth: 420, marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            const name = canAdd.find((c) => c.id === adding.clientId)?.displayName ?? 'The client';
            setNote('');
            void act(`/v1/people/${p.identityId}/clients`, { method: 'POST', body: adding }).then(
              (r) => {
                if (!r) return;
                setAdding({ clientId: '', roleLabel: '' });
                setNote(
                  (r as { told?: boolean }).told
                    ? `${name} added. ${who} was told.`
                    : `${name} added.`,
                );
              },
            );
          }}
        >
          <strong>Add a client</strong>
          <span style={{ fontSize: 13 }}>
            They can see it at once, and are told by email or text.
          </span>
          <Select
            label="Client"
            value={adding.clientId}
            onChange={(e) => setAdding({ ...adding, clientId: e.target.value })}
          >
            <option value="">Choose a client</option>
            {canAdd.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </Select>
          <Input
            label="Role (optional, e.g. Spouse)"
            name="addRole"
            value={adding.roleLabel}
            onChange={(e) => setAdding({ ...adding, roleLabel: e.target.value })}
          />
          <div>
            <Button type="submit" disabled={busy || !adding.clientId}>
              Add client
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Account">
        <div style={{ display: 'grid', gap: 8, maxWidth: 560 }}>
          <span>
            Created {when(p.createdAt)}; last signed in{' '}
            {p.lastSignInAt ? when(p.lastSignInAt) : 'never'}.
          </span>
          {off ? (
            <span>
              This account is turned off: they cannot sign in to any client. Their clients and
              history are kept.
            </span>
          ) : (
            <span>
              A sign-in link goes to their email (or by text if they have only a number). It works
              once, for 24 hours.
            </span>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!off && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setNote('');
                  void act(`/v1/people/${p.identityId}/sign-in-link`, { method: 'POST' }).then(
                    (r) => {
                      if (r) setNote(`A sign-in link was sent to ${(r as { to: string }).to}.`);
                    },
                  );
                }}
              >
                Send sign-in link
              </Button>
            )}
            {off ? (
              <Button
                disabled={busy}
                onClick={() =>
                  run(
                    `/v1/people/${p.identityId}/turn-on`,
                    { method: 'POST' },
                    'Account turned on.',
                  )
                }
              >
                Turn account on
              </Button>
            ) : (
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Turn off ${who}'s account? They are signed out at once and cannot sign in to any client until it is turned on again.`,
                    )
                  ) {
                    run(
                      `/v1/people/${p.identityId}/turn-off`,
                      { method: 'POST' },
                      'Account turned off.',
                    );
                  }
                }}
              >
                Turn account off
              </Button>
            )}
          </div>
        </div>
      </Card>

      <HistoryCard
        title="Activity"
        path={`/v1/people/${p.identityId}/history`}
        empty="Nothing yet."
        load={history}
        showClient
      />
    </div>
  );
}

/** One logo on Settings > Firm: shown, replaced, removed (P53; P60 the dark-mode one). */
function LogoSetting({
  title,
  note,
  path,
  src,
  dark = false,
  has,
  version,
  busy,
  act,
  changed,
}: {
  title: string;
  note: string;
  path: string;
  src: string;
  dark?: boolean;
  has: boolean;
  version: number;
  busy: boolean;
  act: (path: string, init: { method?: string; body?: unknown; raw?: Blob }) => Promise<unknown>;
  changed: () => void;
}): JSX.Element {
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
      <strong>{title}</strong>
      {has && (
        <img
          src={`${src}?v=${version}`}
          alt={dark ? 'Firm logo for dark mode' : 'Firm logo'}
          // Shown on the background it is made for, whatever this device's own setting.
          style={{
            maxHeight: 60,
            maxWidth: 240,
            justifySelf: 'start',
            padding: 8,
            borderRadius: 6,
            background: dark ? '#11151b' : '#ffffff',
          }}
        />
      )}
      <label>
        <span>{note} </span>
        <input
          type="file"
          accept="image/png,image/jpeg"
          aria-label={`Choose the ${title.toLowerCase()}`}
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Cleared, so the same file can be chosen again.
            e.target.value = '';
            if (f) {
              void act(path, { method: 'PUT', raw: f }).then((r) => {
                if (r) changed();
              });
            }
          }}
        />
      </label>
      {has && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void act(path, { method: 'DELETE' }).then(changed)}
        >
          {dark ? 'Remove dark-mode logo' : 'Remove logo'}
        </Button>
      )}
    </div>
  );
}

interface SettingsData {
  firmName: string;
  accentColor: string;
  uploadLimitMb: number;
  uploadKeepDays: number;
  hasLogo: boolean;
  /** P60: a logo for dark mode. */
  hasDarkLogo?: boolean;
  portalUrl: string;
  /** Clients may send secure links to files shared with them (P55). */
  clientLinks: boolean;
  /** Downloads each new secure link allows; 0 for no limit (P58). */
  /** Empty while being typed: not saved until it is a number. */
  shareDownloadLimit: number | '';
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
              // Empty is not 0 ("no limit"): nothing is saved until it is a number.
              if (form.shareDownloadLimit === '') return;
              void act('/v1/settings', {
                method: 'PUT',
                body: {
                  firmName: form.firmName,
                  accentColor: form.accentColor,
                  uploadLimitMb: Number(form.uploadLimitMb),
                  uploadKeepDays: Number(form.uploadKeepDays),
                  clientLinks: form.clientLinks,
                  shareDownloadLimit: form.shareDownloadLimit,
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
            <Input
              label="Downloads allowed per secure link sent outside (0 for no limit)"
              name="shareDownloads"
              type="number"
              min={0}
              max={1000}
              value={form.shareDownloadLimit}
              onChange={(e) =>
                setForm({
                  ...form,
                  shareDownloadLimit: e.target.value === '' ? '' : Number(e.target.value),
                })
              }
            />
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                checked={form.clientLinks}
                onChange={(e) => setForm({ ...form, clientLinks: e.target.checked })}
              />
              <span>
                <strong>Clients may send secure links</strong>: a client can send files you shared
                with them to someone outside, such as a lender, with the same secure link staff
                send. Always watermarked, at most 30 days; you see each link on the client&rsquo;s
                page and can revoke it.
              </span>
            </label>
            <Button type="submit" disabled={busy || form.shareDownloadLimit === ''}>
              Save
            </Button>
          </form>
          <LogoSetting
            title="Logo"
            note="PNG or JPEG, at most 512 KB. Shown in light mode, and in dark mode when there is no dark-mode logo."
            path="/v1/settings/logo"
            src="/api/portal/branding/logo"
            has={Boolean(s.data?.hasLogo)}
            version={logoV}
            busy={busy}
            act={act}
            changed={() => {
              setLogoV((v) => v + 1);
              reloadBranding();
            }}
          />
          <LogoSetting
            title="Logo for dark mode (optional)"
            note="PNG or JPEG, at most 512 KB. Shown when the device is set to dark mode: a version with light lettering on a clear background."
            path="/v1/settings/logo/dark"
            src="/api/portal/branding/logo/dark"
            dark
            has={Boolean(s.data?.hasDarkLogo)}
            version={logoV}
            busy={busy}
            act={act}
            changed={() => {
              setLogoV((v) => v + 1);
              reloadBranding();
            }}
          />
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
                    <CloseIcon size={16} />
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
          <strong>Clients may notify</strong>: a client sending files can choose to have this person
          emailed, with the file names and their note. Clients see the names of those ticked who can
          see their client, never their email addresses.
        </p>
        <p>
          <strong>Access requests</strong>: this person is emailed when someone confirms a request
          for access, with the name and who they say they are with. Only for staff who see every
          client (they approve requests).
        </p>
        <Table
          head={[
            'Name',
            'Email',
            'State',
            'Sees',
            'Clients may notify',
            'Access requests',
            'Last sign-in',
            'Actions',
          ]}
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
                <td style={td}>
                  {/* P59: emailed when someone confirms a request for access. */}
                  <input
                    type="checkbox"
                    aria-label={`Email ${u.name} new access requests`}
                    checked={u.notifyAccessRequests && !u.clientIds}
                    disabled={busy || !u.active || me.data === null || u.clientIds !== null}
                    title={u.clientIds ? 'Only for staff who see every client' : undefined}
                    onChange={(e) =>
                      void act(`/v1/staff/${u.id}`, {
                        method: 'PATCH',
                        body: { notifyAccessRequests: e.target.checked },
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
      <Card title="Sign-in with Vibe Auth">
        <p style={{ marginTop: 0 }}>
          With Vibe Auth on the appliance, staff can sign in with their Vibe Auth account instead of
          a portal password and authenticator code. Anyone Vibe Auth lets in gets a staff account
          here on first sign-in; Vibe Auth groups decide who is an admin. The portal keeps its own
          sign-in until you choose single sign-on only.
        </p>
        <AuthSettingsPage
          basePath="/api/staff/sso"
          productName="Vibe Portal"
          classNames={{
            root: 'vauth',
            section: 'vauth-section',
            label: 'vauth-label',
            input: 'vauth-input',
            button: 'vauth-button',
            buttonPrimary: 'vauth-button vauth-primary',
            buttonDanger: 'vauth-button vauth-danger',
            table: 'vauth-table',
            note: 'vauth-note',
            error: 'vauth-error',
          }}
        />
      </Card>
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
        border: '1px solid var(--vibe-color-border)',
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
