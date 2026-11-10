// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

type Reply = { status?: number; body: unknown };
type Calls = { path: string; method?: string; body: unknown }[];

const NO_FILES: Reply = { body: { files: [], years: [] } };
const NO_UPLOADS: Reply = { body: { uploads: [] } };

/** Fakes the API: each path answers with the given reply. */
function serve(routes: Record<string, Reply>): Calls {
  const calls: Calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api/portal', '');
      calls.push({
        path,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const r =
        routes[path] ??
        (path.startsWith('/files') ? (routes['/files'] ?? NO_FILES) : undefined) ??
        (path === '/uploads' ? NO_UPLOADS : undefined);
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

const ME = {
  identity: { id: 'i1', name: 'John Smith', email: 'john@example.test', phone: null },
  clients: [
    { id: 'c1', name: 'Smith, John' },
    { id: 'c2', name: 'Smith Farms LLC' },
  ],
  activeClientId: 'c1',
  firmName: 'Example CPA',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('portal', () => {
  it('sends a signed-out visitor to sign in', async () => {
    serve({ '/auth/me': { status: 401, body: { error: 'signed_out' } } });
    at('/');
    await screen.findByRole('heading', { name: 'Sign in' });
  });

  it('signs in with a mobile number and a code', async () => {
    const calls = serve({
      '/auth/login': { body: { ok: true, kind: 'phone' } },
      '/auth/verify-code': { body: { ok: true } },
      '/auth/me': { body: ME },
    });
    at('/login');
    fireEvent.change(screen.getByLabelText('Email or mobile number'), {
      target: { value: '555-201-3344' },
    });
    fireEvent.click(screen.getByLabelText(/Keep me signed in/));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Signed in as John Smith.');
    expect(calls.find((c) => c.path === '/auth/login')?.body).toEqual({
      contact: '555-201-3344',
      keepSignedIn: true,
    });
    expect(calls.find((c) => c.path === '/auth/verify-code')?.body).toEqual({
      phone: '555-201-3344',
      code: '123456',
    });
  });

  it('says to check email when signing in with an email', async () => {
    serve({ '/auth/login': { body: { ok: true, kind: 'email' } } });
    at('/login');
    fireEvent.change(screen.getByLabelText('Email or mobile number'), {
      target: { value: 'john@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'Check your email' });
  });

  it('shows a wrong code in plain words', async () => {
    serve({
      '/auth/login': { body: { ok: true, kind: 'phone' } },
      '/auth/verify-code': { status: 400, body: { error: 'code_wrong' } },
    });
    at('/login');
    fireEvent.change(screen.getByLabelText('Email or mobile number'), {
      target: { value: '5552013344' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not right/);
  });

  it('lets a person with several clients switch between them', async () => {
    const calls = serve({
      '/auth/me': { body: ME },
      '/auth/switch-client': { body: { ok: true } },
    });
    at('/');
    fireEvent.change(await screen.findByLabelText('Showing files for'), {
      target: { value: 'c2' },
    });
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/auth/switch-client')?.body).toEqual({ clientId: 'c2' }),
    );
  });

  it('requests access, then confirms it with a code', async () => {
    const calls = serve({
      '/access-requests': { status: 201, body: { requestId: 'r1', sentTo: 'm***@example.test' } },
      '/access-requests/r1/confirm': { body: { ok: true } },
    });
    at('/request-access');
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mary Smith' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'mary@example.test' } });
    fireEvent.change(screen.getByLabelText(/Whose files/), { target: { value: 'Smith, John' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await screen.findByText(/sent a 6-digit code to m\*\*\*@example.test/);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '654321' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByRole('heading', { name: 'Request sent' });
    expect(calls[0]?.body).toEqual({
      name: 'Mary Smith',
      email: 'mary@example.test',
      clientAs: 'Smith, John',
    });
  });

  it('a sign-in link is used only when the person presses Sign in (scanners open links)', async () => {
    const calls = serve({
      '/auth/verify-link': { body: { ok: true } },
      '/auth/me': { body: ME },
    });
    window.history.replaceState(null, '', '/auth/verify#t=abcdefghijklmnopqrstuvwxyz');
    render(
      <MemoryRouter initialEntries={['/auth/verify']}>
        <App />
      </MemoryRouter>,
    );
    await screen.findByRole('button', { name: 'Sign in' });
    expect(calls).toEqual([]);
    expect(window.location.hash).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByText('Signed in as John Smith.');
    expect(calls[0]).toMatchObject({
      path: '/auth/verify-link',
      body: { token: 'abcdefghijklmnopqrstuvwxyz' },
    });
  });

  it('offers Try again when the portal cannot be reached', async () => {
    serve({ '/auth/me': { status: 503, body: { error: 'down' } } });
    at('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Try again' });
  });

  it('says so when switching client fails', async () => {
    serve({
      '/auth/me': { body: ME },
      '/auth/switch-client': { status: 404, body: { error: 'not_found' } },
    });
    at('/');
    fireEvent.change(await screen.findByLabelText('Showing files for'), {
      target: { value: 'c2' },
    });
    expect((await screen.findByRole('alert')).textContent).toMatch(/went wrong/);
  });

  it('request access can send a new code', async () => {
    const calls = serve({
      '/access-requests': { status: 201, body: { requestId: 'r1', sentTo: 'm***@example.test' } },
      '/access-requests/r1/resend': { body: { sentTo: 'm***@example.test' } },
    });
    at('/request-access');
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Mary' } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'm@example.test' } });
    fireEvent.change(screen.getByLabelText(/Whose files/), { target: { value: 'Smith' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send a new code' }));
    await waitFor(() => expect(calls.map((c) => c.path)).toContain('/access-requests/r1/resend'));
  });

  it('lists shared files with New and Updated, and filters by year', async () => {
    const calls = serve({
      '/auth/me': { body: ME },
      '/files': {
        body: {
          files: [
            {
              id: 'f1',
              name: '2025 Form 1040.pdf',
              size: 2_400_000,
              contentType: 'application/pdf',
              taxYear: 2025,
              sharedAt: '2026-11-09T15:00:00Z',
              updatedAt: '2026-11-12T15:00:00Z',
              isNew: true,
              preview: 'pdf',
            },
            {
              id: 'f2',
              name: 'Organizer.xlsx',
              size: 5000,
              contentType: 'application/octet-stream',
              taxYear: 2024,
              sharedAt: '2026-10-01T15:00:00Z',
              updatedAt: null,
              isNew: false,
              preview: null,
            },
          ],
          years: [2025, 2024],
        },
      },
    });
    at('/');
    await screen.findByText('2025 Form 1040.pdf');
    expect(screen.getByText('New')).toBeTruthy();
    expect(screen.getByText(/^Updated /)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open 2025 Form 1040.pdf' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open Organizer.xlsx' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download Organizer.xlsx' }).getAttribute('href')).toBe(
      '/api/portal/files/f2/content?mode=download',
    );
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2024' } });
    await waitFor(() => expect(calls.map((c) => c.path)).toContain('/files?year=2024'));
  });

  it('says when there are no files yet', async () => {
    serve({ '/auth/me': { body: ME } });
    at('/');
    await screen.findByText('No files yet');
  });

  it('opens a picture in the portal', async () => {
    serve({
      '/files': {
        body: {
          files: [
            {
              id: 'p1',
              name: 'Receipt.jpg',
              size: 100,
              contentType: 'image/jpeg',
              taxYear: null,
              sharedAt: '2026-11-09T15:00:00Z',
              updatedAt: null,
              isNew: true,
              preview: 'image',
            },
          ],
          years: [],
        },
      },
    });
    at('/files/p1');
    const img = await screen.findByRole('img', { name: 'Receipt.jpg' });
    expect(img.getAttribute('src')).toBe('/api/portal/files/p1/content?mode=view');
  });

  it('lists my uploads: Remove until the firm has it, then "Received by the firm"', async () => {
    const calls = serve({
      '/auth/me': { body: ME },
      '/uploads': {
        body: {
          uploads: [
            {
              id: 'u1',
              name: 'W-2.pdf',
              size: 10,
              note: '',
              uploadedAt: '2026-11-09T15:00:00Z',
              received: false,
            },
            {
              id: 'u2',
              name: '1099.pdf',
              size: 10,
              note: '',
              uploadedAt: '2026-11-08T15:00:00Z',
              received: true,
            },
          ],
        },
      },
      '/uploads/u1': { body: { ok: true } },
    });
    at('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove W-2.pdf' }));
    expect(screen.queryByRole('button', { name: 'Remove 1099.pdf' })).toBeNull();
    expect(screen.getByText('Received by the firm')).toBeTruthy();
    await waitFor(() => expect(calls.find((c) => c.path === '/uploads/u1')?.method).toBe('DELETE'));
  });

  it('sends chosen files one after another with one batch and note, and shows each result', async () => {
    const sent: { url: string; type: string | null }[] = [];
    class FakeXhr {
      upload: {
        onprogress:
          ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
      } = {
        onprogress: null,
      };
      status = 0;
      responseText = '';
      withCredentials = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private url = '';
      private type: string | null = null;
      open(_m: string, url: string): void {
        this.url = url;
      }
      setRequestHeader(_k: string, v: string): void {
        this.type = v;
      }
      send(): void {
        sent.push({ url: this.url, type: this.type });
        const bad = this.url.includes('name=setup.exe');
        this.status = bad ? 415 : 201;
        this.responseText = JSON.stringify(
          bad ? { error: 'type_not_allowed' } : { uploadId: `u${sent.length}`, name: 'x' },
        );
        setTimeout(() => this.onload?.(), 0);
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    serve({ '/auth/me': { body: ME } });
    at('/');
    const input = await screen.findByLabelText(/^Files \(up to 20/);
    fireEvent.change(input, {
      target: {
        files: [
          new File(['%PDF'], 'W-2.pdf', { type: 'application/pdf' }),
          new File(['MZ'], 'setup.exe'),
        ],
      },
    });
    fireEvent.change(screen.getByLabelText('Note for the firm (optional)'), {
      target: { value: 'Second job' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send 2 files' }));
    await screen.findByText(/cannot be sent/);
    expect(screen.getByText(/W-2.pdf: sent/)).toBeTruthy();
    expect(sent).toHaveLength(2);
    const q = sent.map((x) => new URL(x.url, 'http://h').searchParams);
    expect(q[0]?.get('batchId')).toBe(q[1]?.get('batchId'));
    expect(q.map((p) => p.get('note'))).toEqual(['Second job', 'Second job']);
    expect(q.map((p) => p.get('clientId'))).toEqual(['c1', 'c1']);
    expect(sent[0]?.type).toBe('application/octet-stream');
  });

  it('will not send more than 20 files at once', async () => {
    serve({ '/auth/me': { body: ME } });
    at('/');
    const input = await screen.findByLabelText(/^Files \(up to 20/);
    const files = Array.from({ length: 21 }, (_, i) => new File(['x'], `f${i}.txt`));
    fireEvent.change(input, { target: { files } });
    expect(screen.getByText('Choose at most 20 files at a time.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Send 21 files' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
