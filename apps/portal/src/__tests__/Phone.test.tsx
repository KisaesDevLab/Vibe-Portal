// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P50: "Sign in by text" on the home page, and the number offered on an invitation.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

type Reply = { status?: number; body: unknown };
type Calls = { path: string; method?: string; body: unknown }[];

/** Fakes the API: each "METHOD path" or path answers with the given reply. */
function serve(routes: Record<string, Reply>): Calls {
  const calls: Calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api/portal', '');
      const method = init?.method ?? 'GET';
      calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r =
        routes[`${method} ${path}`] ??
        routes[path] ??
        (path.startsWith('/files') ? { body: { files: [], years: [] } } : undefined) ??
        (path === '/uploads' ? { body: { uploads: [] } } : undefined);
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

const me = (phone: string | null, email: string | null = 'john@example.test') => ({
  identity: { id: 'i1', name: 'John Smith', email, phone },
  clients: [{ id: 'c1', name: 'Smith, John' }],
  activeClientId: 'c1',
  firmName: 'Example CPA',
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('sign in by text (P50)', () => {
  it('adds a number after the texted code', async () => {
    const calls = serve({
      '/auth/me': { body: me(null) },
      'POST /account/phone': { body: { ok: true, phone: '***-***-3344' } },
      '/account/phone/verify': { body: { ok: true, phone: '+15552013344' } },
    });
    at('/');
    fireEvent.change(await screen.findByLabelText('Mobile number'), {
      target: { value: '555-201-3344' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    await screen.findByText(/on its way by text to \*\*\*-\*\*\*-3344/);
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/You can now sign in with this number/);
    screen.getByText('You can sign in with a code texted to +15552013344.');
    expect(calls.find((c) => c.path === '/account/phone')?.body).toEqual({
      phone: '555-201-3344',
    });
    expect(calls.find((c) => c.path === '/account/phone/verify')?.body).toEqual({
      code: '123456',
    });
  });

  it('says why a number is refused', async () => {
    serve({
      '/auth/me': { body: me(null) },
      'POST /account/phone': { body: { ok: true, phone: '***-***-3344' } },
      '/account/phone/verify': { status: 409, body: { error: 'phone_in_use' } },
    });
    at('/');
    fireEvent.change(await screen.findByLabelText('Mobile number'), {
      target: { value: '5552013344' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Text me a code' }));
    fireEvent.change(await screen.findByLabelText('Code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/already used to sign in to another portal account/);
  });

  it('removes the number', async () => {
    const calls = serve({
      '/auth/me': { body: me('+15552013344') },
      'DELETE /account/phone': { body: { ok: true } },
    });
    at('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove this number' }));
    await screen.findByText('Removed. You sign in by email.');
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/account/phone')).toBe(true);
    screen.getByLabelText('Mobile number');
  });

  it('cannot remove the only way to sign in', async () => {
    serve({ '/auth/me': { body: me('+15552013344', null) } });
    at('/');
    await screen.findByText(/code texted to \+15552013344/);
    expect(screen.queryByRole('button', { name: 'Remove this number' })).toBeNull();
  });

  it('an invitation offers the number, and the code waits on the home page', async () => {
    const calls = serve({
      '/invitations/preview': {
        body: {
          firmName: 'Example CPA',
          clientName: 'Smith, John',
          name: 'John',
          contact: 'j***@example.test',
          alsoPhone: '***-***-3344',
        },
      },
      '/invitations/accept': { body: { ok: true, phoneCode: 'sent', phone: '***-***-3344' } },
      '/auth/me': { body: me(null) },
    });
    at('/invite#t=abcdefghijklmnopqrstuvwxyz');
    fireEvent.click(
      await screen.findByLabelText(/Also let me sign in by text at \*\*\*-\*\*\*-3344/),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign in' }));
    await screen.findByText(/on its way by text to \*\*\*-\*\*\*-3344/);
    screen.getByLabelText('Code');
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/invitations/accept')?.body).toMatchObject({
        addPhone: true,
      }),
    );
  });

  it('an invitation without a second number offers nothing', async () => {
    serve({
      '/invitations/preview': {
        body: {
          firmName: 'Example CPA',
          clientName: 'Smith, John',
          name: 'John',
          contact: 'j***@example.test',
          alsoPhone: null,
        },
      },
    });
    at('/invite#t=abcdefghijklmnopqrstuvwxyz');
    await screen.findByRole('button', { name: 'Accept and sign in' });
    expect(screen.queryByLabelText(/Also let me sign in by text/)).toBeNull();
  });
});

describe('a portal without text messages (P50)', () => {
  it('says so instead of offering a number', async () => {
    serve({ '/auth/me': { body: { ...me(null), textsOn: false } } });
    at('/');
    await screen.findByText(/This portal does not send text messages/);
    expect(screen.queryByLabelText('Mobile number')).toBeNull();
  });
});

describe('sign in by text, edge cases (P50)', () => {
  it('a phone-only account is not offered another number', async () => {
    serve({ '/auth/me': { body: me('+15552013344', null) } });
    at('/');
    await screen.findByText(/code texted to \+15552013344/);
    expect(screen.queryByText('Use another number')).toBeNull();
  });

  it('says on the home page why no code came after accepting', async () => {
    serve({
      '/invitations/preview': {
        body: {
          firmName: 'Example CPA',
          clientName: 'Smith, John',
          name: 'John',
          contact: 'j***@example.test',
          alsoPhone: '***-***-3344',
        },
      },
      '/invitations/accept': { body: { ok: true, phoneCode: 'too_many_requests', phone: 'x' } },
      '/auth/me': { body: me(null) },
    });
    at('/invite#t=abcdefghijklmnopqrstuvwxyz');
    fireEvent.click(await screen.findByLabelText(/Also let me sign in by text/));
    fireEvent.click(screen.getByRole('button', { name: 'Accept and sign in' }));
    await screen.findByText(/Too many tries.*You can add your mobile number below/);
    screen.getByLabelText('Mobile number');
  });
});
