// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Addendum 01 (P80-P88) on the pages: the request page asks for what the firm chose (no ID, a
// picture, or front and back); staff see what the barcode said and say how they checked; an
// admin sets both on Settings.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import { reloadBranding } from '../branding';

type Reply = { status?: number; body: unknown };
type Calls = { path: string; method: string; body: unknown }[];

/** Fakes /api: "METHOD path" or "path" answers with the reply (the path as the page asks it,
 *  after /api/portal or /api/staff). */
function serve(routes: Record<string, Reply>): Calls {
  const calls: Calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(/^\/api\/(portal|staff)/, '');
      const method = init?.method ?? 'GET';
      const raw = init?.body;
      calls.push({
        path,
        method,
        body: raw instanceof Blob ? raw : typeof raw === 'string' ? JSON.parse(raw) : raw,
      });
      const r = routes[`${method} ${path}`] ?? routes[path];
      if (!r) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  // The request page reads what to ask for from the firm's branding.
  reloadBranding();
  return calls;
}

function at(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const branding = (requestIdMode: string): Reply => ({
  body: { firmName: 'Example CPA', accentColor: '#0f6cbd', hasLogo: false, requestIdMode },
});
const picture = (name: string): File =>
  new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: 'image/jpeg' });

function fillRequest(): void {
  fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mary Smith' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mary@example.test' } });
  fireEvent.change(screen.getByLabelText(/Whose files/), { target: { value: 'Smith, John' } });
}
const sendButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Send request' }) as HTMLButtonElement;

describe('request page (P88, layer A)', () => {
  const made: Reply = { status: 201, body: { requestId: 'r1', sentTo: 'm***@example.test' } };

  it('no ID: nothing is asked for but the contact', async () => {
    const calls = serve({
      '/branding': branding('none'),
      '/access-requests': made,
      '/access-requests/r1/confirm': { body: { ok: true } },
    });
    at('/request-access');
    await waitFor(() => expect(screen.queryByLabelText(/Photo of your ID/)).toBeNull());
    fillRequest();
    expect(sendButton().disabled).toBe(false);
    fireEvent.click(sendButton());
    await screen.findByText(/sent a 6-digit code/);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(calls.some((c) => c.path.includes('id-photo'))).toBe(false);
    expect(calls.find((c) => c.path.endsWith('/confirm'))?.body).toEqual({ code: '654321' });
  });

  it('front and back: both are sent, and an unread barcode is asked for once more', async () => {
    const calls = serve({
      '/branding': branding('scan'),
      '/access-requests': made,
      '/access-requests/r1/id-photo': { status: 201, body: { ok: true } },
      '/access-requests/r1/id-photo?side=back': {
        status: 201,
        body: { ok: true, readable: false },
      },
      '/access-requests/r1/confirm': { body: { ok: true } },
    });
    at('/request-access');
    const front = await screen.findByLabelText(/Front of your ID/);
    fillRequest();
    fireEvent.change(front, { target: { files: [picture('front.jpg')] } });
    // The back too, or the person's word that there is no barcode.
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText(/To send it, add the back of your ID/)).toBeTruthy();
    const back = picture('back.jpg');
    fireEvent.change(screen.getByLabelText('Back of your ID'), { target: { files: [back] } });
    fireEvent.click(sendButton());
    await screen.findByText(/could not read the barcode on the back/);
    expect(calls.find((c) => c.path.endsWith('?side=back'))?.body).toBe(back);

    // It may be taken again, or the request goes on with the first picture.
    const again = picture('back-2.jpg');
    fireEvent.change(screen.getByLabelText('Back of your ID'), { target: { files: [again] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send the back' }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith('?side=back')).map((c) => c.body)).toEqual([
        back,
        again,
      ]),
    );
    // Not asked a third time, though this one was not read either.
    await waitFor(() => expect(screen.queryByText(/could not read the barcode/)).toBeNull());
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(calls.find((c) => c.path.endsWith('/confirm'))?.body).toEqual({ code: '654321' });
  });

  it('asks for the back when the portal does, though the page did not know to', async () => {
    // The firm's setting could not be read: the page asks for one picture, as it used to.
    const routes: Record<string, Reply> = {
      '/access-requests': made,
      '/access-requests/r1/id-photo': { status: 201, body: { ok: true } },
      '/access-requests/r1/id-photo?side=back': { status: 201, body: { ok: true, readable: true } },
      '/access-requests/r1/confirm': { status: 400, body: { error: 'id_back_required' } },
    };
    const calls = serve(routes);
    at('/request-access');
    const one = await screen.findByLabelText(/Photo of your ID/);
    fillRequest();
    fireEvent.change(one, {
      target: { files: [picture('front.jpg')] },
    });
    fireEvent.click(sendButton());
    await screen.findByText(/sent a 6-digit code/);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    // Told why, and given a way to send the back.
    await screen.findByText(/Add a picture of the back of your ID first/);
    const back = picture('back.jpg');
    fireEvent.change(screen.getByLabelText('Back of your ID'), { target: { files: [back] } });
    routes['/access-requests/r1/confirm'] = { body: { ok: true } };
    fireEvent.click(screen.getByRole('button', { name: 'Send the back' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('?side=back'))).toBe(true));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'Request sent' });
  });

  it('asks for the front when the portal does, though the firm asked for none when the page opened', async () => {
    const routes: Record<string, Reply> = {
      '/branding': branding('none'),
      '/access-requests': made,
      '/access-requests/r1/id-photo': { status: 201, body: { ok: true } },
      '/access-requests/r1/confirm': { status: 400, body: { error: 'id_required' } },
    };
    const calls = serve(routes);
    at('/request-access');
    await waitFor(() => expect(screen.queryByLabelText(/Photo of your ID/)).toBeNull());
    fillRequest();
    fireEvent.click(sendButton());
    await screen.findByText(/sent a 6-digit code/);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText('Add a photo of your ID first.');
    // A way to add it, and nothing confirmed until it is sent.
    const front = picture('front.jpg');
    fireEvent.change(screen.getByLabelText(/Photo of your ID/), { target: { files: [front] } });
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    routes['/access-requests/r1/confirm'] = { body: { ok: true } };
    fireEvent.click(screen.getByRole('button', { name: 'Send photo ID' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/id-photo'))).toBe(true));
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'Request sent' });
  });

  it('no barcode can be said at the code, when the back is asked for only then', async () => {
    const routes: Record<string, Reply> = {
      '/branding': branding('photo'),
      '/access-requests': made,
      '/access-requests/r1/id-photo': { status: 201, body: { ok: true } },
      '/access-requests/r1/confirm': { status: 400, body: { error: 'id_back_required' } },
    };
    const calls = serve(routes);
    at('/request-access');
    const one = await screen.findByLabelText(/Photo of your ID/);
    fillRequest();
    fireEvent.change(one, { target: { files: [picture('passport.jpg')] } });
    fireEvent.click(sendButton());
    await screen.findByText(/sent a 6-digit code/);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/Add a picture of the back of your ID first/);
    // A passport has no back to send: said here, and the request goes on.
    routes['/access-requests/r1/confirm'] = { body: { ok: true } };
    fireEvent.click(screen.getByLabelText(/My ID has no barcode/));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(calls.filter((c) => c.path.endsWith('/confirm')).at(-1)?.body).toEqual({
      code: '654321',
      noBarcode: true,
    });
  });

  it('an ID with no barcode goes front only, and the portal is told', async () => {
    const calls = serve({
      '/branding': branding('scan'),
      '/access-requests': made,
      '/access-requests/r1/id-photo': { status: 201, body: { ok: true } },
      '/access-requests/r1/confirm': { body: { ok: true } },
    });
    at('/request-access');
    const front = await screen.findByLabelText(/Front of your ID/);
    fillRequest();
    fireEvent.change(front, { target: { files: [picture('passport.jpg')] } });
    fireEvent.click(screen.getByLabelText(/My ID has no barcode/));
    expect(screen.queryByLabelText('Back of your ID')).toBeNull();
    fireEvent.click(sendButton());
    await screen.findByText(/sent a 6-digit code/);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(calls.some((c) => c.path.endsWith('?side=back'))).toBe(false);
    expect(calls.find((c) => c.path.endsWith('/confirm'))?.body).toEqual({
      code: '654321',
      noBarcode: true,
    });
  });
});

const ME: Reply = {
  body: {
    email: 'ann@firm.test',
    name: 'Ann Staff',
    firmName: 'Example CPA',
    admin: true,
    allClients: true,
  },
};
const CLIENT = {
  id: '11111111-1111-4111-8111-111111111111',
  clientCode: '1001',
  displayName: 'Smith, John',
  active: true,
  users: 1,
  files: 1,
  waiting: 0,
};
const REQUEST = {
  id: 'r1',
  name: 'Jane Smith',
  email: 'jane@example.test',
  phone: null,
  confirmedContact: 'jane@example.test',
  clientAs: 'John Smith',
  note: '',
  createdAt: '2026-11-01T10:00:00Z',
  idPhoto: { contentType: 'image/jpeg', size: 1000 },
  idBack: { contentType: 'image/jpeg', size: 1000 },
  idScan: {
    familyName: 'SMITH',
    firstName: 'JANET',
    middleName: 'ANN',
    dob: '1980-02-29',
    expires: '2025-01-31',
    issued: '2021-01-31',
    address: { street: '1 MAIN ST', city: 'RICHMOND', state: 'VA', zip: '23220' },
    issuer: 'VA, USA',
  },
  idFlags: ['expired', 'name_differs'],
};

describe('staff page (layers A and B)', () => {
  it('shows both sides, what the barcode said and the flags', async () => {
    serve({
      '/auth/me': ME,
      '/v1/clients': { body: { clients: [CLIENT] } },
      '/v1/access-requests': { body: { requestCheck: 'off', requests: [REQUEST] } },
    });
    at('/staff/requests');
    const box = (await screen.findByText('Jane Smith')).parentElement as HTMLElement;
    expect(within(box).getByAltText('Back of the ID sent by Jane Smith').getAttribute('src')).toBe(
      '/api/staff/v1/access-requests/r1/id-photo?side=back',
    );
    const flags = within(box).getByRole('list', { name: "Flags on Jane Smith's ID" });
    expect(
      within(flags)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['The ID has expired', 'The name on the ID differs from the name on the request']);
    expect(within(box).getByText('JANET ANN SMITH')).toBeTruthy();
    expect(within(box).getByText('1980-02-29')).toBeTruthy();
    expect(within(box).getByText('1 MAIN ST, RICHMOND, VA, 23220')).toBeTruthy();
  });

  it('with a check required, Approve asks how the person was checked', async () => {
    const calls = serve({
      '/auth/me': ME,
      '/v1/clients': { body: { clients: [CLIENT] } },
      '/v1/access-requests': {
        body: { requestCheck: 'required', requests: [{ ...REQUEST, idFlags: [] }] },
      },
      'POST /v1/access-requests/r1/approve': { body: { ok: true } },
    });
    at('/staff/requests');
    const box = (await screen.findByText('Jane Smith')).parentElement as HTMLElement;
    await within(box).findByRole('option', { name: /Smith, John/ });
    fireEvent.change(within(box).getByLabelText('Client for Jane Smith'), {
      target: { value: CLIENT.id },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'Approve Jane Smith' }));
    const how = within(box).getByRole('group', { name: 'How did you check Jane Smith?' });
    // Nothing is sent until a way is chosen, and its note given.
    const go = within(how).getByRole('button', {
      name: 'Approve Jane Smith with this check',
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(calls.some((c) => c.path.endsWith('/approve'))).toBe(false);
    fireEvent.click(within(how).getByLabelText('Called the number in our records'));
    expect(go.disabled).toBe(true);
    fireEvent.change(within(how).getByLabelText('Who you spoke to'), {
      target: { value: ' Jane, at home ' },
    });
    fireEvent.click(go);
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/v1/access-requests/r1/approve')?.body).toEqual({
        clientIds: [CLIENT.id],
        roleLabel: '',
        check: { method: 'callback', note: 'Jane, at home' },
      }),
    );
  });

  it('a check required since the page was read: the refusal opens the question', async () => {
    const routes: Record<string, Reply> = {
      '/auth/me': ME,
      '/v1/clients': { body: { clients: [CLIENT] } },
      '/v1/access-requests': { body: { requestCheck: 'off', requests: [REQUEST] } },
      'POST /v1/access-requests/r1/approve': { status: 400, body: { error: 'check_required' } },
    };
    const calls = serve(routes);
    at('/staff/requests');
    const box = (await screen.findByText('Jane Smith')).parentElement as HTMLElement;
    await within(box).findByRole('option', { name: /Smith, John/ });
    fireEvent.change(within(box).getByLabelText('Client for Jane Smith'), {
      target: { value: CLIENT.id },
    });
    // An admin has turned the check on meanwhile.
    routes['/v1/access-requests'] = { body: { requestCheck: 'required', requests: [REQUEST] } };
    fireEvent.click(screen.getByRole('button', { name: 'Approve Jane Smith' }));
    const how = await screen.findByRole('group', { name: 'How did you check Jane Smith?' });
    routes['POST /v1/access-requests/r1/approve'] = { body: { ok: true } };
    fireEvent.click(within(how).getByLabelText('Met in person'));
    fireEvent.click(
      within(how).getByRole('button', { name: 'Approve Jane Smith with this check' }),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.path.endsWith('/approve')).at(-1)?.body).toMatchObject({
        check: { method: 'in_person', note: '' },
      }),
    );
  });

  it('met in person needs no note', async () => {
    const calls = serve({
      '/auth/me': ME,
      '/v1/clients': { body: { clients: [CLIENT] } },
      '/v1/access-requests': { body: { requestCheck: 'required', requests: [REQUEST] } },
      'POST /v1/access-requests/r1/approve': { body: { ok: true } },
    });
    at('/staff/requests');
    const box = (await screen.findByText('Jane Smith')).parentElement as HTMLElement;
    await within(box).findByRole('option', { name: /Smith, John/ });
    fireEvent.change(within(box).getByLabelText('Client for Jane Smith'), {
      target: { value: CLIENT.id },
    });
    fireEvent.click(within(box).getByRole('button', { name: 'Approve Jane Smith' }));
    fireEvent.click(within(box).getByLabelText('Met in person'));
    fireEvent.click(
      within(box).getByRole('button', { name: 'Approve Jane Smith with this check' }),
    );
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/approve'))?.body).toMatchObject({
        check: { method: 'in_person', note: '' },
      }),
    );
  });

  it('settings: an admin chooses the ID asked for and whether a check is required', async () => {
    const calls = serve({
      '/auth/me': ME,
      '/v1/settings': {
        body: {
          firmName: 'Example CPA',
          accentColor: '#0f6cbd',
          uploadLimitMb: 95,
          uploadKeepDays: 30,
          hasLogo: false,
          portalUrl: 'https://portal.example.test',
          clientLinks: false,
          shareDownloadLimit: 5,
          requestIdMode: 'photo',
          requestCheck: 'off',
        },
      },
      'PUT /v1/settings': { body: { ok: true } },
      '/v1/keys': { body: { keys: [] } },
      '/v1/clients': { body: { clients: [CLIENT] } },
      '/v1/staff': { body: { staff: [] } },
    });
    at('/staff/settings');
    const mode = (await screen.findByLabelText(/ID with a request/)) as HTMLSelectElement;
    expect(mode.value).toBe('photo');
    const check = screen.getByLabelText(/Check before approving/) as HTMLSelectElement;
    expect(check.value).toBe('off');
    fireEvent.change(mode, { target: { value: 'scan' } });
    fireEvent.change(check, { target: { value: 'required' } });
    const form = mode.closest('form') as HTMLElement;
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT' && c.path === '/v1/settings')?.body).toEqual({
        firmName: 'Example CPA',
        accentColor: '#0f6cbd',
        uploadLimitMb: 95,
        uploadKeepDays: 30,
        clientLinks: false,
        shareDownloadLimit: 5,
        requestIdMode: 'scan',
        requestCheck: 'required',
      }),
    );
  });
});
