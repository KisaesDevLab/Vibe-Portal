// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { screenWidth } from './setup';

type Reply = { status?: number; body: unknown };
type Calls = { path: string; method: string; body: unknown }[];

/** Fakes /api/staff: "METHOD path" or "path" (any method) answers with the reply. */
function serve(routes: Record<string, Reply>): Calls {
  const calls: Calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api/staff', '');
      const method = init?.method ?? 'GET';
      const raw = init?.body;
      calls.push({
        path,
        method,
        body: typeof raw === 'string' ? JSON.parse(raw) : raw,
      });
      const r =
        routes[`${method} ${path}`] ??
        routes[path] ??
        // A client page's heading and its uploads (P54), unless a test says otherwise.
        (/^\/v1\/clients\/[^/?]+$/.test(path) ? { body: CLIENT } : undefined) ??
        (path.startsWith('/v1/uploads?clientId=') ? { body: { uploads: [] } } : undefined);
      if (!r) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

function at(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const ME: Reply = {
  body: {
    email: 'ann@firm.test',
    name: 'Ann Staff',
    firmName: 'Example CPA',
    admin: true,
    allClients: true,
  },
};
const SETTINGS: Reply = {
  body: {
    firmName: 'Example CPA',
    accentColor: '#0f6cbd',
    uploadLimitMb: 95,
    uploadKeepDays: 30,
    hasLogo: false,
    portalUrl: 'https://portal.example.test',
  },
};
const ANN = {
  id: 's1',
  email: 'ann@firm.test',
  name: 'Ann Staff',
  active: true,
  ready: true,
  lastSignInAt: null,
  admin: true,
  clientIds: null,
};
const CLIENT = {
  id: '11111111-1111-4111-8111-111111111111',
  clientCode: '1001',
  displayName: 'Smith, John',
  active: true,
  users: 1,
  files: 1,
  waiting: 2,
};
const USER = {
  identityId: '22222222-2222-4222-8222-222222222222',
  name: 'John Smith',
  email: 'john@example.test',
  phone: null,
  roleLabel: 'Owner',
  active: true,
  lastSignInAt: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('staff page', () => {
  it('sends a signed-out person to staff sign in', async () => {
    serve({
      '/auth/me': { status: 401, body: { error: 'signed_out' } },
      '/auth/status': { body: { setupNeeded: false } },
    });
    at('/staff');
    await screen.findByRole('heading', { name: 'Staff sign in' });
  });

  it('before any account, with no first admin set, sign-in points to the appliance console', async () => {
    serve({ '/auth/status': { body: { setupNeeded: true, firstAdmin: null } } });
    at('/staff/login');
    expect(await screen.findByText(/no staff account yet/)).toBeTruthy();
    expect(screen.getByText(/First admin.s email/)).toBeTruthy();
    // No command line for the firm to type.
    expect(document.body.textContent).not.toMatch(/sudo|docker/);
  });

  it('before any account, sign-in says where the setup link went, and sends it again', async () => {
    const calls = serve({
      '/auth/status': {
        body: {
          setupNeeded: true,
          firstAdmin: { to: 'k•••@firm.test', at: '2026-11-10T15:00:00Z', ok: true },
        },
      },
      'POST /auth/setup/resend': {
        body: { firstAdmin: { to: 'k•••@firm.test', at: '2026-11-10T16:00:00Z', ok: true } },
      },
    });
    at('/staff/login');
    expect(await screen.findByText('k•••@firm.test')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send again' }));
    expect(await screen.findByText(/A new link was/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.path === '/auth/setup/resend')).toBe(true);
  });

  it('a setup email that failed points to the email settings', async () => {
    serve({
      '/auth/status': {
        body: {
          setupNeeded: true,
          firstAdmin: { to: 'k•••@firm.test', at: '2026-11-10T15:00:00Z', ok: false },
        },
      },
    });
    at('/staff/login');
    expect(await screen.findByText(/could not be sent/)).toBeTruthy();
    expect(screen.getByText(/Email & SMS/)).toBeTruthy();
  });

  it('signs in with email, password and authenticator code', async () => {
    const calls = serve({
      '/auth/status': { body: { setupNeeded: false } },
      'POST /auth/login': { body: { ok: true } },
      '/auth/me': ME,
      '/v1/clients': { body: { clients: [CLIENT] } },
    });
    at('/staff/login');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'ann@firm.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long password' } });
    fireEvent.change(screen.getByLabelText(/Code from your authenticator/), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('link', { name: 'Smith, John' });
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({
      email: 'ann@firm.test',
      password: 'a long password',
      code: '123456',
    });
  });

  it('shows a locked account in plain words', async () => {
    serve({
      '/auth/status': { body: { setupNeeded: false } },
      'POST /auth/login': { status: 429, body: { error: 'locked' } },
    });
    at('/staff/login');
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@b.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/Code from/), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/locked for 15 minutes/);
  });

  it('first account: setup link, password, authenticator, then signed in', async () => {
    window.location.hash = '#t=tok123';
    const calls = serve({
      'POST /auth/setup/preview': {
        body: { first: true, email: '', name: '', firmName: 'Example CPA' },
      },
      'POST /auth/setup': {
        body: { otpauthUrl: 'otpauth://totp/x', secret: 'ABCDEFGHIJKLMNOP' },
      },
      'POST /auth/setup/confirm': { body: { ok: true } },
      '/auth/me': ME,
      '/v1/clients': { body: { clients: [] } },
    });
    at('/staff/setup');
    fireEvent.change(await screen.findByLabelText('Your email'), {
      target: { value: 'ann@firm.test' },
    });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ann Staff' } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: 'a long password' } });
    fireEvent.change(screen.getByLabelText('The password again'), {
      target: { value: 'a long password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    // A QR code to scan, drawn on the page; the key to type is there too, for a phone that cannot scan.
    const qr = (await screen.findByAltText(/QR code for your authenticator/)) as HTMLImageElement;
    expect(qr.src).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(qr.src)).toContain('<svg');
    expect(screen.getByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/6-digit code/), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    await screen.findByRole('heading', { name: 'Clients' });
    expect(calls.find((c) => c.path === '/auth/setup')?.body).toEqual({
      token: 'tok123',
      password: 'a long password',
      email: 'ann@firm.test',
      name: 'Ann Staff',
    });
    expect(calls.find((c) => c.path === '/auth/setup/confirm')?.body).toEqual({
      token: 'tok123',
      code: '654321',
    });
    // The token is taken out of the address bar.
    expect(window.location.hash).toBe('');
  });

  it('keeps the setup token when React renders twice (development StrictMode)', async () => {
    window.location.hash = '#t=strict123';
    const calls = serve({
      'POST /auth/setup/preview': {
        body: { first: true, email: '', name: '', firmName: 'Example CPA' },
      },
    });
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/staff/setup']}>
          <App />
        </MemoryRouter>
      </StrictMode>,
    );
    await screen.findByLabelText('Your email');
    const previews = calls.filter((c) => c.path === '/auth/setup/preview');
    expect(previews.length).toBeGreaterThan(0);
    for (const c of previews) expect(c.body).toEqual({ token: 'strict123' });
  });

  it('a used setup link says so', async () => {
    window.location.hash = '#t=old';
    serve({ 'POST /auth/setup/preview': { status: 410, body: { error: 'setup_link_expired' } } });
    at('/staff/setup');
    expect((await screen.findByRole('alert')).textContent).toMatch(/expired or was used/);
  });

  it('client page: invite someone, hide a file from a person, remove a file', async () => {
    const id = CLIENT.id;
    const calls = serve({
      '/auth/me': ME,
      '/v1/clients': { body: { clients: [CLIENT] } },
      [`/v1/clients/${id}/users`]: { body: { users: [USER], invitations: [] } },
      [`/v1/files?clientId=${id}`]: {
        body: {
          files: [
            {
              fileId: 'f1',
              name: 'Smith 2025 Form 1040.pdf',
              size: 10,
              taxYear: 2025,
              sharedAt: '2026-11-01T10:00:00Z',
              sharedBy: 'PC1\\ann',
              contentUpdatedAt: null,
              users: [{ identityId: USER.identityId, visible: true, viewedAt: null }],
            },
          ],
        },
      },
      [`/v1/shares?clientId=${id}`]: { body: { shares: [] } },
      [`POST /v1/clients/${id}/invites`]: { status: 201, body: { invitationId: 'i1' } },
      'PUT /v1/files/f1/visibility': { body: { ok: true } },
      'DELETE /v1/files/f1': { body: { ok: true } },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    at('/staff');
    fireEvent.click(await screen.findByRole('link', { name: 'Smith, John' }));
    expect(await screen.findByText(/John Smith \(not opened\)/)).toBeTruthy();
    // Whose page it is, at the top (P54).
    expect(await screen.findByRole('heading', { name: 'Smith, John' })).toBeTruthy();
    expect(screen.getByText(/Client 1001/)).toBeTruthy();

    // The invite form only after "Invite someone" (P54).
    expect(screen.queryByLabelText('Email')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jane@example.test' } });
    fireEvent.change(screen.getByLabelText('Role (e.g. Spouse)'), { target: { value: 'Spouse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/invites'))?.body).toEqual({
        email: 'jane@example.test',
        roleLabel: 'Spouse',
      }),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Hide Smith 2025 Form 1040.pdf from John Smith' }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        users: { [USER.identityId]: false },
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Smith 2025 Form 1040.pdf' }));
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/files/f1')).toBe(true),
    );
  });

  it('approves an access request for the chosen client', async () => {
    const calls = serve({
      '/auth/me': ME,
      '/v1/clients': { body: { clients: [CLIENT] } },
      '/v1/access-requests': {
        body: {
          requests: [
            {
              id: 'r1',
              name: 'Jane Smith',
              email: 'jane@example.test',
              phone: null,
              confirmedContact: 'jane@example.test',
              clientAs: 'John Smith',
              note: '',
              createdAt: '2026-11-01T10:00:00Z',
            },
          ],
        },
      },
      'POST /v1/access-requests/r1/approve': { body: { ok: true } },
    });
    at('/staff/requests');
    const box = (await screen.findByText('Jane Smith')).parentElement as HTMLElement;
    const approve = within(box).getByRole('button', {
      name: 'Approve Jane Smith',
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await within(box).findByRole('option', { name: /Smith, John/ });
    fireEvent.change(within(box).getByLabelText('Client for Jane Smith'), {
      target: { value: CLIENT.id },
    });
    expect(
      within(within(box).getByRole('list', { name: 'Clients for Jane Smith' })).getByText(
        /Smith, John/,
      ),
    ).toBeTruthy();
    fireEvent.click(approve);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/access-requests/r1/approve')?.body).toEqual({
        clientIds: [CLIENT.id],
        roleLabel: '',
      }),
    );
  });

  it("a client's people show every client each can see, as small tags (P62)", async () => {
    serve({
      '/auth/me': ME,
      [`/v1/clients/${CLIENT.id}/users`]: {
        body: {
          users: [
            {
              ...USER,
              clients: [
                { id: CLIENT.id, name: 'Smith, John' },
                { id: 'c2', name: 'Smith Farms LLC' },
              ],
            },
          ],
          invitations: [],
        },
      },
      [`/v1/files?clientId=${CLIENT.id}`]: { body: { files: [] } },
      [`/v1/shares?clientId=${CLIENT.id}`]: { body: { shares: [] } },
    });
    at(`/staff/clients/${CLIENT.id}`);
    const tags = await screen.findByRole('list', { name: 'Clients John Smith can see' });
    const items = within(tags).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual(['Smith, John', 'Smith Farms LLC']);
    // This client is plain text; the other one opens its page.
    expect(within(items[0] as HTMLElement).queryByRole('link')).toBeNull();
    expect(within(tags).getByRole('link', { name: 'Smith Farms LLC' }).getAttribute('href')).toBe(
      '/staff/clients/c2',
    );
  });

  it('approves an access request for several clients, and one can be taken off (P61)', async () => {
    const farm = { ...CLIENT, id: 'c2', displayName: 'Smith Farms LLC', clientCode: 'FARM' };
    const jones = { ...CLIENT, id: 'c3', displayName: 'Jones, Ann', clientCode: 'JONES' };
    const calls = serve({
      '/auth/me': ME,
      '/v1/clients': { body: { clients: [CLIENT, farm, jones] } },
      '/v1/access-requests': {
        body: {
          requests: [
            {
              id: 'r1',
              name: 'Jane Smith',
              email: 'jane@example.test',
              phone: null,
              confirmedContact: 'jane@example.test',
              clientAs: 'The Smiths',
              note: '',
              createdAt: '2026-11-01T10:00:00Z',
            },
          ],
        },
      },
      'POST /v1/access-requests/r1/approve': { body: { ok: true } },
    });
    at('/staff/requests');
    const box = (await screen.findByText('Jane Smith')).parentElement as HTMLElement;
    await within(box).findByRole('option', { name: /Smith, John/ });
    fireEvent.change(within(box).getByLabelText('Client for Jane Smith'), {
      target: { value: CLIENT.id },
    });
    // Once one is chosen it leaves the list, and the list offers another.
    const more = within(box).getByLabelText('Add another client for Jane Smith');
    expect(within(more).queryByRole('option', { name: /Smith, John/ })).toBeNull();
    fireEvent.change(more, { target: { value: 'c2' } });
    fireEvent.change(within(box).getByLabelText('Add another client for Jane Smith'), {
      target: { value: 'c3' },
    });
    fireEvent.click(
      within(box).getByRole('button', { name: 'Remove Jones, Ann (JONES) for Jane Smith' }),
    );
    const chosen = within(box).getByRole('list', { name: 'Clients for Jane Smith' });
    expect(within(chosen).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(within(box).getByRole('button', { name: 'Approve Jane Smith' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/access-requests/r1/approve')?.body).toEqual({
        clientIds: [CLIENT.id, 'c2'],
        roleLabel: '',
      }),
    );
  });

  it('settings: a new key is shown once, and adding staff shows the setup link', async () => {
    const calls = serve({
      '/auth/me': ME,
      '/v1/settings': SETTINGS,
      '/v1/keys': { body: { keys: [] } },
      '/v1/clients': { body: { clients: [CLIENT] } },
      '/v1/staff': { body: { staff: [ANN] } },
      'POST /v1/keys': { status: 201, body: { id: 'k1', key: 'vpk_secret' } },
      'POST /v1/staff': {
        status: 201,
        body: { id: 's2', setupLink: 'https://portal.example.test/staff/setup#t=abc' },
      },
    });
    at('/staff/settings');
    fireEvent.change(await screen.findByLabelText('New key name'), {
      target: { value: 'Office PC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make a key' }));
    expect(await screen.findByText('vpk_secret')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'bob@firm.test' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bob' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add staff' }));
    expect(await screen.findByText(/staff\/setup#t=abc/)).toBeTruthy();
    expect(screen.getByText(/Setup link for Bob \(bob@firm.test\)/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/v1/staff')?.body).toEqual({
      email: 'bob@firm.test',
      name: 'Bob',
      admin: false,
    });
    // The key is shown only until the next thing done.
    expect(screen.queryByText('vpk_secret')).toBeNull();
    // Your own row cannot be turned off or reset.
    expect(screen.getByText('you')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Ann Staff/ })).toBeNull();
  });

  it('settings: limits a staff member to the clients ticked (P48)', async () => {
    const other = { ...CLIENT, id: '33333333-3333-4333-8333-333333333333', displayName: 'Jones' };
    const bob = { ...ANN, id: 's2', email: 'bob@firm.test', name: 'Bob', admin: false };
    const calls = serve({
      '/auth/me': ME,
      '/v1/settings': SETTINGS,
      '/v1/keys': { body: { keys: [] } },
      '/v1/clients': { body: { clients: [CLIENT, other] } },
      '/v1/staff': {
        body: {
          staff: [
            ANN,
            bob,
            { ...bob, id: 's3', email: 'cy@firm.test', name: 'Cy', clientIds: [other.id] },
          ],
        },
      },
      'PATCH /v1/staff/s2': { body: { ok: true } },
      'PATCH /v1/staff/s3': { body: { ok: true } },
    });
    at('/staff/settings');
    const row = (await screen.findByText('bob@firm.test')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Every client')).toBeTruthy();
    expect(screen.getByText('Admin: every client')).toBeTruthy();
    expect(screen.getByText('1 client')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Access for Bob' }));
    const form = screen.getByRole('form', { name: 'Access for Bob' });
    fireEvent.click(within(form).getByLabelText('Sees only these clients'));
    expect(within(form).getByText(/they will see no clients/)).toBeTruthy();
    fireEvent.click(await within(form).findByLabelText(/Smith, John/));
    fireEvent.click(within(form).getByRole('button', { name: 'Save access' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/staff/s2')?.body).toEqual({
        admin: false,
        clientIds: [CLIENT.id],
      }),
    );
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Access for Bob' })).toBeNull());

    // Made an admin: the list they had is not sent.
    fireEvent.click(screen.getByRole('button', { name: 'Access for Cy' }));
    const cy = screen.getByRole('form', { name: 'Access for Cy' });
    expect((within(cy).getByLabelText(/Jones/) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(cy).getByLabelText(/^Admin/));
    fireEvent.click(within(cy).getByRole('button', { name: 'Save access' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/staff/s3')?.body).toEqual({
        admin: true,
        clientIds: null,
      }),
    );
  });

  it('settings: an admin ticks who is emailed about access requests (P59)', async () => {
    const bob = { ...ANN, id: 's2', email: 'bob@firm.test', name: 'Bob', admin: false };
    const cy = { ...bob, id: 's3', email: 'cy@firm.test', name: 'Cy', clientIds: [CLIENT.id] };
    const calls = serve({
      '/auth/me': ME,
      '/v1/settings': SETTINGS,
      '/v1/keys': { body: { keys: [] } },
      '/v1/clients': { body: { clients: [CLIENT] } },
      '/v1/staff': {
        body: {
          staff: [
            ANN,
            { ...bob, notifyAccessRequests: false },
            { ...cy, notifyAccessRequests: true },
          ],
        },
      },
      'PATCH /v1/staff/s2': { body: { ok: true } },
    });
    at('/staff/settings');
    const box = (await screen.findByLabelText('Email Bob new access requests')) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/staff/s2')?.body).toEqual({
        notifyAccessRequests: true,
      }),
    );
    // Someone limited to some clients cannot approve requests, so it is off and cannot be ticked.
    const limited = screen.getByLabelText('Email Cy new access requests') as HTMLInputElement;
    expect([limited.checked, limited.disabled]).toEqual([false, true]);
  });

  it('settings: a refused change says why by the button, and reads who you are again', async () => {
    const bob = { ...ANN, id: 's2', email: 'bob@firm.test', name: 'Bob', admin: false };
    const calls = serve({
      '/auth/me': ME,
      '/v1/settings': SETTINGS,
      '/v1/keys': { body: { keys: [] } },
      '/v1/clients': { body: { clients: [CLIENT] } },
      '/v1/staff': { body: { staff: [ANN, bob] } },
      'PATCH /v1/staff/s2': { status: 403, body: { error: 'admins_only' } },
    });
    at('/staff/settings');
    await screen.findByText('bob@firm.test');
    // Your own row has no buttons.
    expect(screen.queryByRole('button', { name: 'Access for Ann Staff' })).toBeNull();
    const before = calls.filter((c) => c.path === '/v1/clients').length;
    const me = calls.filter((c) => c.path === '/auth/me').length;
    fireEvent.click(screen.getByRole('button', { name: 'Access for Bob' }));
    // The clients are read again, so one added since can be ticked.
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/v1/clients').length).toBeGreaterThan(before),
    );
    const form = screen.getByRole('form', { name: 'Access for Bob' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save access' }));
    expect(await within(form).findByText('Only an admin can do that.')).toBeTruthy();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/auth/me').length).toBeGreaterThan(me),
    );
  });

  it('settings: a B2 bucket is checked and saved, the key never shown, files moved (P51)', async () => {
    const empty = {
      storage: 'local',
      bothInUse: false,
      b2: { endpoint: '', bucket: '', keyId: '', hasKey: false },
      move: null,
    };
    const saved = {
      ...empty,
      b2: {
        endpoint: 's3.us-west-004.backblazeb2.com',
        bucket: 'example-cpa-portal',
        keyId: '004abc',
        hasKey: true,
      },
    };
    const routes: Record<string, Reply> = {
      '/auth/me': ME,
      '/v1/settings': SETTINGS,
      '/v1/keys': { body: { keys: [] } },
      '/v1/clients': { body: { clients: [] } },
      '/v1/staff': { body: { staff: [ANN] } },
      '/v1/settings/storage': { body: empty },
      'PUT /v1/settings/storage/b2': {
        status: 400,
        body: { error: 'b2_check_failed', detail: 'Key not valid' },
      },
    };
    const calls = serve(routes);
    at('/staff/settings');
    await screen.findByText(/stored/);
    fireEvent.change(screen.getByLabelText(/^Endpoint/), {
      target: { value: 's3.us-west-004.backblazeb2.com' },
    });
    fireEvent.change(screen.getByLabelText('Bucket name'), {
      target: { value: 'example-cpa-portal' },
    });
    fireEvent.change(screen.getByLabelText('Key ID'), { target: { value: '004abc' } });
    fireEvent.change(screen.getByLabelText('Application key'), { target: { value: 'K004secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and save' }));
    expect(
      await screen.findByText('The bucket could not be used with that key. B2 said: Key not valid'),
    ).toBeTruthy();
    expect(
      calls.find((c) => c.method === 'PUT' && c.path === '/v1/settings/storage/b2')?.body,
    ).toEqual({
      endpoint: 's3.us-west-004.backblazeb2.com',
      bucket: 'example-cpa-portal',
      keyId: '004abc',
      appKey: 'K004secret',
    });

    routes['PUT /v1/settings/storage/b2'] = { body: saved };
    routes['/v1/settings/storage'] = { body: saved };
    fireEvent.click(screen.getByRole('button', { name: 'Check and save' }));
    // Saved: the key field empties and now says the saved one is kept if left empty.
    const keyField = (await screen.findByLabelText(
      'Application key (leave empty to keep the saved one)',
    )) as HTMLInputElement;
    expect(keyField.value).toBe('');

    routes['POST /v1/settings/storage/move'] = {
      status: 202,
      body: { ...saved, move: { to: 'b2', state: 'requested', by: 'ann@firm.test' } },
    };
    routes['/v1/settings/storage'] = {
      body: {
        ...saved,
        storage: 'b2',
        bothInUse: true,
        move: { to: 'b2', state: 'running', by: 'ann@firm.test', copied: 3, total: 10 },
      },
    };
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move files to B2' }));
    expect(await screen.findByText('Moving in the B2 bucket: 3 of 10 files checked.')).toBeTruthy();
    expect(calls.find((c) => c.path === '/v1/settings/storage/move')?.body).toEqual({ to: 'b2' });
    // Files are on their way to the bucket: it cannot be changed.
    expect((screen.getByLabelText('Bucket name') as HTMLInputElement).disabled).toBe(true);
  });

  it('staff who are not admins have no Settings; limited staff no Requests (P48)', async () => {
    serve({
      '/auth/me': { body: { ...(ME.body as object), admin: false, allClients: false } },
      '/v1/clients': { body: { clients: [] } },
    });
    at('/staff/settings');
    // Sent back to Clients.
    await screen.findByRole('heading', { name: 'Clients' });
    expect(screen.getByText('You see the clients an admin chose for you.')).toBeTruthy();
    expect(screen.getByText('No clients chosen for you yet.')).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Staff' });
    expect(within(nav).queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Requests' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Uploads' })).toBeTruthy();
  });

  it('staff who see every client but are not admins keep Requests (P48)', async () => {
    serve({
      '/auth/me': { body: { ...(ME.body as object), admin: false } },
      '/v1/clients': { body: { clients: [CLIENT] } },
    });
    at('/staff');
    await screen.findByRole('link', { name: 'Smith, John' });
    const nav = screen.getByRole('navigation', { name: 'Staff' });
    expect(within(nav).getByRole('link', { name: 'Requests' })).toBeTruthy();
    expect(within(nav).queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByText('You see the clients an admin chose for you.')).toBeNull();
  });

  it('a page whose session ended goes to sign in', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = url.replace('/api/staff', '');
        if (path === '/auth/me' && n++ === 0) return new Response(JSON.stringify(ME.body));
        if (path === '/auth/status') return new Response(JSON.stringify({ setupNeeded: false }));
        return new Response(JSON.stringify({ error: 'signed_out' }), { status: 401 });
      }),
    );
    at('/staff/uploads');
    await screen.findByRole('heading', { name: 'Staff sign in' });
  });

  it('a failed load says so with Try again', async () => {
    const calls = serve({ '/auth/me': ME, '/v1/uploads': { status: 500, body: { error: 'x' } } });
    at('/staff/uploads');
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/v1/uploads')).toHaveLength(2));
  });

  it('a reload part way through setup says to open the link again', async () => {
    window.location.hash = '';
    serve({});
    at('/staff/setup');
    expect((await screen.findByRole('alert')).textContent).toMatch(/Open the setup link again/);
  });

  it('on a phone the menu folds behind a button, and tables become labelled cards (P59)', async () => {
    screenWidth(390);
    try {
      serve({ '/auth/me': ME, '/v1/clients': { body: { clients: [CLIENT] } } });
      at('/staff');
      const menu = await screen.findByRole('button', { name: 'Menu' });
      expect(screen.queryByRole('navigation', { name: 'Staff' })).toBeNull();
      expect(document.documentElement.dataset['narrow']).toBe('1');
      // Each cell carries its column's name for the card.
      const link = await screen.findByRole('link', { name: 'Smith, John' });
      expect(link.closest('td')?.dataset['label']).toBe('Client');
      fireEvent.click(menu);
      const nav = screen.getByRole('navigation', { name: 'Staff' });
      expect(within(nav).getByRole('link', { name: 'Uploads' })).toBeTruthy();
      expect(within(nav).getByRole('button', { name: 'Sign out' })).toBeTruthy();
    } finally {
      screenWidth(1280);
    }
  });

  it('offers Vibe Auth sign-in when the firm has turned it on (P44)', async () => {
    const status = (mode: string) => ({
      body: {
        mode,
        product: 'vibe-files-portal',
        oidc: {
          enabled: true,
          idpName: 'Vibe Auth',
          reachable: true,
          startPath: '/api/staff/sso/auth/oidc/start',
        },
        localLoginVisible: mode !== 'oidc_only',
        breakglassPath: '/staff/login?local=1',
      },
    });
    serve({ '/auth/status': { body: { setupNeeded: false } }, '/sso/auth/status': status('both') });
    at('/staff/login');
    const sso = (await screen.findByRole('link', {
      name: 'Sign in with Vibe Auth',
    })) as HTMLAnchorElement;
    expect(sso.getAttribute('href')).toBe('/api/staff/sso/auth/oidc/start?return_to=%2Fstaff');
    // Both: the portal's own sign-in is still there.
    expect(screen.getByLabelText('Password')).toBeTruthy();
    cleanup();

    // Single sign-on only: the form is behind the emergency link.
    serve({
      '/auth/status': { body: { setupNeeded: false } },
      '/sso/auth/status': status('oidc_only'),
    });
    at('/staff/login');
    await screen.findByRole('link', { name: 'Sign in with Vibe Auth' });
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getByRole('link', { name: 'Emergency sign-in' }).getAttribute('href')).toBe(
      '/staff/login?local=1',
    );
  });

  it('without Vibe Auth, sign-in is as before (P44)', async () => {
    serve({
      '/auth/status': { body: { setupNeeded: false } },
      '/sso/auth/status': {
        body: {
          mode: 'local',
          product: 'vibe-files-portal',
          oidc: { enabled: false, idpName: '', reachable: false, startPath: '' },
          localLoginVisible: true,
          breakglassPath: '',
        },
      },
    });
    at('/staff/login');
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Sign in with/ })).toBeNull();
  });

  it('long client lists come a page at a time (P57)', async () => {
    const clients = Array.from({ length: 120 }, (_, i) => ({
      ...CLIENT,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      clientCode: String(2000 + i),
      displayName: `Client ${String(i).padStart(3, '0')}`,
    }));
    serve({ '/auth/me': ME, '/v1/clients': { body: { clients } } });
    at('/staff');
    expect(await screen.findByText('1–50 of 120')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Client 000' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Client 050' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('51–100 of 120')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Client 050' })).toBeTruthy();
    // A search starts again at the first page.
    fireEvent.change(screen.getByLabelText('Find a client'), { target: { value: 'Client 11' } });
    expect(await screen.findByRole('link', { name: 'Client 110' })).toBeTruthy();
    expect(screen.queryByText(/of 120/)).toBeNull();
  });

  it('History shows the newest events, and older ones on request (P57)', async () => {
    const ev = (id: number, kind: string) => ({
      id,
      at: '2026-11-01T10:00:00Z',
      kind,
      actorKind: 'staff',
      actor: 'ann@firm.test',
      clientId: null,
      detail: {},
    });
    // A full page of 100, so there may be more.
    const page = Array.from({ length: 100 }, (_, i) => ev(200 - i, 'staff_sign_in'));
    const calls = serve({
      '/auth/me': ME,
      '/v1/events?latest=1&limit=100': { body: { events: page } },
      '/v1/events?latest=1&limit=100&before=101': { body: { events: [ev(7, 'settings_updated')] } },
    });
    at('/staff/history');
    expect((await screen.findAllByText('staff sign in')).length).toBe(100);
    fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('settings updated')).toBeTruthy();
    expect(calls.some((c) => c.path === '/v1/events?latest=1&limit=100&before=101')).toBe(true);
    // Fewer than a page came back: nothing older.
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  const portalFile = (fileId: string, name: string): object => ({
    fileId,
    name,
    size: 10,
    taxYear: 2025,
    sharedAt: '2026-11-01T10:00:00Z',
    sharedBy: 'PC1\\ann',
    contentUpdatedAt: null,
    users: [],
  });
  const LINK = {
    id: 's1',
    email: 'pat@first-bank.test',
    name: 'Pat Roe',
    organization: 'First Bank',
    canDownload: false,
    watermark: true,
    createdAt: '2026-11-02T10:00:00Z',
    createdBy: 'ann@firm.test',
    expiresAt: '2026-12-02T10:00:00Z',
    revokedAt: null,
    opens: 2,
    lastOpenedAt: '2026-11-03T10:00:00Z',
    status: 'opened',
    files: [
      { fileId: 'f1', name: 'Return.pdf', removed: false },
      { fileId: 'f9', name: 'Old.pdf', removed: true },
    ],
  };

  it('client page: sends files to someone outside by a secure link, and revokes one (P49)', async () => {
    const id = CLIENT.id;
    const calls = serve({
      '/auth/me': ME,
      [`/v1/clients/${id}/users`]: { body: { users: [USER], invitations: [] } },
      [`/v1/files?clientId=${id}`]: {
        body: { files: [portalFile('f1', 'Return.pdf'), portalFile('f2', 'W-2.pdf')] },
      },
      [`/v1/shares?clientId=${id}`]: {
        body: {
          shares: [
            LINK,
            { ...LINK, id: 's0', status: 'revoked', revokedAt: '2026-11-04T10:00:00Z' },
            { ...LINK, id: 's-1', status: 'locked', revokedAt: '2026-11-04T10:00:00Z' },
          ],
        },
      },
      'POST /v1/shares': { status: 201, body: { shareId: 's2', expiresAt: '2026-11-17T15:00Z' } },
      'DELETE /v1/shares/s1': { body: { ok: true } },
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    at(`/staff/clients/${id}`);

    // What was sent before: who, what, and what became of it.
    const cell = await screen.findAllByText('Pat Roe (pat@first-bank.test), First Bank');
    const row = within(cell[0]?.closest('tr') as HTMLElement);
    expect(row.getByText('Return.pdf, Old.pdf (removed)')).toBeTruthy();
    expect(row.getByText('View only, watermarked')).toBeTruthy();
    expect(row.getByText('Opened')).toBeTruthy();
    expect(row.getByText(/^2 times, last /)).toBeTruthy();
    expect(screen.getByText('Locked: too many wrong codes')).toBeTruthy();
    // Only a link that still works can be ended.
    expect(screen.getAllByRole('button', { name: /^Revoke the link/ })).toHaveLength(1);

    expect(screen.queryByLabelText('Recipient email')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Send W-2.pdf securely' }));
    expect((screen.getByLabelText('W-2.pdf') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Return.pdf') as HTMLInputElement).checked).toBe(false);
    const send = screen.getByRole('button', { name: 'Send secure link' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('Return.pdf'));
    fireEvent.change(screen.getByLabelText('Recipient email'), {
      target: { value: ' lee@title-co.test ' },
    });
    fireEvent.change(screen.getByLabelText('Recipient name'), { target: { value: 'Lee Poe' } });
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'Title Co' } });
    fireEvent.change(screen.getByLabelText('Access'), { target: { value: 'download' } });
    fireEvent.change(screen.getByLabelText('Link works for'), { target: { value: '7' } });
    fireEvent.click(screen.getByLabelText(/^Watermark PDFs/));
    fireEvent.change(screen.getByLabelText('Message in the email (optional)'), {
      target: { value: 'For the closing.' },
    });
    fireEvent.click(send);
    expect((await screen.findByRole('status')).textContent).toBe(
      'Secure link sent to lee@title-co.test. It expires in 7 days and can be revoked anytime.',
    );
    expect(calls.find((c) => c.method === 'POST' && c.path === '/v1/shares')?.body).toEqual({
      clientId: id,
      fileIds: ['f1', 'f2'],
      email: 'lee@title-co.test',
      name: 'Lee Poe',
      organization: 'Title Co',
      message: 'For the closing.',
      canDownload: true,
      watermark: true,
      days: 7,
    });
    // The form closes, and the list is read again.
    expect(screen.queryByLabelText('Recipient email')).toBeNull();
    await waitFor(() =>
      expect(calls.filter((c) => c.path === `/v1/shares?clientId=${id}`)).toHaveLength(2),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Revoke the link sent to pat@first-bank.test' }),
    );
    expect(confirm).toHaveBeenCalledWith(
      'Revoke the link sent to pat@first-bank.test? It stops working at once, even if it is open.',
    );
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.path === '/v1/shares/s1')).toBe(true),
    );
  });

  it('client page: a secure link the portal refuses says why, and the form stays (P49)', async () => {
    const id = CLIENT.id;
    serve({
      '/auth/me': ME,
      [`/v1/clients/${id}/users`]: { body: { users: [], invitations: [] } },
      [`/v1/files?clientId=${id}`]: { body: { files: [portalFile('f1', 'letter.docx')] } },
      [`/v1/shares?clientId=${id}`]: { body: { shares: [] } },
      'POST /v1/shares': { status: 400, body: { error: 'view_only_needs_preview' } },
    });
    at(`/staff/clients/${id}`);
    expect(await screen.findByText(/None yet\. Use/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Send letter.docx securely' }));
    fireEvent.change(screen.getByLabelText('Recipient email'), {
      target: { value: 'lee@title-co.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send secure link' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'View only works for PDFs and pictures',
    );
    expect((screen.getByLabelText('Recipient email') as HTMLInputElement).value).toBe(
      'lee@title-co.test',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Recipient email')).toBeNull();
  });
});
