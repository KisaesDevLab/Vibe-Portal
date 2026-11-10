// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

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
      const r = routes[`${method} ${path}`] ?? routes[path];
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

  it('before any account, sign-in says to make a setup link on the appliance', async () => {
    serve({ '/auth/status': { body: { setupNeeded: true } } });
    at('/staff/login');
    expect(await screen.findByText(/sudo vibe portal setup-link/)).toBeTruthy();
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
    expect(await screen.findByText('ABCD EFGH IJKL MNOP')).toBeTruthy();
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
      [`POST /v1/clients/${id}/invites`]: { status: 201, body: { invitationId: 'i1' } },
      'PUT /v1/files/f1/visibility': { body: { ok: true } },
      'DELETE /v1/files/f1': { body: { ok: true } },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    at('/staff');
    fireEvent.click(await screen.findByRole('link', { name: 'Smith, John' }));
    expect(await screen.findByText(/John Smith \(not opened\)/)).toBeTruthy();

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
    fireEvent.click(approve);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/access-requests/r1/approve')?.body).toEqual({
        clientId: CLIENT.id,
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

  it('History asks for the newest events', async () => {
    const calls = serve({
      '/auth/me': ME,
      '/v1/events?latest=1&limit=300': {
        body: {
          events: [
            {
              id: 9,
              at: '2026-11-01T10:00:00Z',
              kind: 'staff_sign_in',
              actorKind: 'staff',
              actor: 'ann@firm.test',
              clientId: null,
              detail: {},
            },
          ],
        },
      },
    });
    at('/staff/history');
    expect(await screen.findByText('staff sign in')).toBeTruthy();
    expect(calls.some((c) => c.path === '/v1/events?latest=1&limit=300')).toBe(true);
  });
});
