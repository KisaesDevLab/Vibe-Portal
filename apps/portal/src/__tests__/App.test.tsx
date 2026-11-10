// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

type Reply = { status?: number; body: unknown };
type Calls = { path: string; body: unknown }[];

/** Fakes the API: each path answers with the given reply. */
function serve(routes: Record<string, Reply>): Calls {
  const calls: Calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api/portal', '');
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = routes[path];
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
});
