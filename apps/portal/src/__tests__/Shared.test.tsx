// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The page a secure link opens for someone outside the client (P49).

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

// The real viewer draws with pdf.js; here it only says what it was asked to show.
vi.mock('../components/ProtectedPdfViewer', async () => {
  const { createElement } = await import('react');
  return {
    ProtectedPdfViewer: (p: { url: string; canDownload: boolean; filename: string }) =>
      createElement(
        'div',
        { 'data-testid': 'pdf', 'data-url': p.url, 'data-download': String(p.canDownload) },
        p.filename,
      ),
  };
});

type Reply = { status?: number; body: unknown };
type Calls = { path: string; body: unknown }[];

const ID = '33333333-3333-4333-8333-333333333333';
const KEY = 'k3y-of_the.link';
const BASE = `/shared/${ID}`;

/** Fakes the API: each path answers with its reply, or with the next of its replies. */
function serve(routes: Record<string, Reply | Reply[]>): Calls {
  const calls: Calls = [];
  const seen: Record<string, number> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('/api/portal', '');
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const route = routes[path];
      const n = seen[path] ?? 0;
      seen[path] = n + 1;
      const r = Array.isArray(route) ? route[Math.min(n, route.length - 1)] : route;
      if (!r) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }),
  );
  return calls;
}

function arrive(hash = `#t=${ID}.${KEY}`): void {
  window.location.hash = hash;
  render(
    <MemoryRouter initialEntries={['/shared']}>
      <App />
    </MemoryRouter>,
  );
}

const WAITING = {
  firmName: 'Example CPA',
  emailMasked: 'p***@first-bank.test',
  expiresAt: '2026-12-09T15:00:00.000Z',
  canDownload: false,
  count: 2,
  verified: false,
};
const PDF = { id: 'f1', name: 'Return-2025.pdf', size: 2048, preview: 'pdf' };
const PNG = { id: 'f2', name: 'scan.png', size: 100, preview: 'image' };
const verified = (more: object = {}): object => ({
  ...WAITING,
  verified: true,
  recipientName: 'Pat Roe',
  organization: 'First Bank',
  verifiedUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
  files: [PDF, PNG],
  ...more,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  window.location.hash = '';
});

describe('a secure link (P49)', () => {
  it('asks for the emailed code, then shows the documents to view only', async () => {
    const calls = serve({
      [`${BASE}/open`]: { body: WAITING },
      [`${BASE}/code`]: { body: { ok: true, emailMasked: WAITING.emailMasked } },
      [`${BASE}/verify`]: { body: verified() },
    });
    arrive();
    expect(await screen.findByText(/Example CPA shared 2 documents with you/)).toBeTruthy();
    expect(screen.getByText('p***@first-bank.test')).toBeTruthy();
    // The secret leaves the address bar, and nothing names a document yet.
    expect(window.location.hash).toBe('');
    expect(screen.queryByText(/Return-2025/)).toBeNull();
    expect(screen.queryByLabelText('Access code')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Send access code' }));
    const field = await screen.findByLabelText('Access code');
    expect(screen.getByRole('status').textContent).toContain('We sent a code to p***@first-bank');
    const verify = screen.getByRole('button', { name: 'Verify code' }) as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    fireEvent.change(field, { target: { value: '12 34x56' } });
    expect((field as HTMLInputElement).value).toBe('123456');
    fireEvent.click(verify);

    await screen.findByRole('heading', { name: 'Shared documents (2)' });
    expect(calls.filter((c) => c.path !== '/branding').map((c) => [c.path, c.body])).toEqual([
      [`${BASE}/open`, { key: KEY }],
      [`${BASE}/code`, { key: KEY }],
      [`${BASE}/verify`, { key: KEY, code: '123456' }],
    ]);
    expect(screen.getByText(/Shared with Pat Roe, First Bank\./)).toBeTruthy();
    expect(screen.getByText(/shared to view only/)).toBeTruthy();
    // Two documents: neither opens by itself, and there is nothing to download.
    expect(screen.queryByTestId('pdf')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View Return-2025.pdf' }));
    const pdf = screen.getByTestId('pdf');
    expect(pdf.getAttribute('data-url')).toBe(
      `/api/portal/shared/${ID}/files/f1/content?mode=view`,
    );
    expect(pdf.getAttribute('data-download')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'View scan.png' }));
    expect(screen.queryByTestId('pdf')).toBeNull();
    const img = screen.getByRole('img', { name: 'scan.png' });
    expect(img.getAttribute('src')).toBe(`/api/portal/shared/${ID}/files/f2/content?mode=view`);
    expect(img.getAttribute('draggable')).toBe('false');
    expect(fireEvent.contextMenu(img)).toBe(false);
  });

  it('one document opens by itself; with download allowed there is a link to save it', async () => {
    serve({
      [`${BASE}/open`]: {
        body: verified({ canDownload: true, count: 2, files: [PDF] }),
      },
    });
    arrive();
    const pdf = await screen.findByTestId('pdf');
    expect(pdf.getAttribute('data-download')).toBe('true');
    expect(screen.getByText(/You can view and download/)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Download Return-2025.pdf' });
    expect(link.getAttribute('href')).toBe(
      `/api/portal/shared/${ID}/files/f1/content?mode=download`,
    );
    expect(link.getAttribute('download')).toBe('Return-2025.pdf');
  });

  it('a file the page cannot show has only its download link', async () => {
    const docx = { id: 'f3', name: 'letter.docx', size: 5_000_000, preview: null };
    serve({ [`${BASE}/open`]: { body: verified({ canDownload: true, count: 1, files: [docx] }) } });
    arrive();
    await screen.findByRole('link', { name: 'Download letter.docx' });
    expect(screen.queryByRole('button', { name: 'View letter.docx' })).toBeNull();
    expect(screen.getByText('letter.docx')).toBeTruthy();
    expect(screen.getByText('4.8 MB')).toBeTruthy();
  });

  it('a file that changed into one the link does not allow is listed, but does not open', async () => {
    const changed = { id: 'f3', name: 'notes.csv', size: 10, preview: null, available: false };
    serve({
      [`${BASE}/open`]: {
        body: verified({
          canDownload: true,
          count: 2,
          files: [changed, { ...PNG, available: true }],
        }),
      },
    });
    arrive();
    expect(await screen.findByText(/Not available: this document has changed/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Download notes.csv' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download scan.png' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View scan.png' })).toBeTruthy();
  });

  it('says why a link does not work', async () => {
    const cases: [Reply | undefined, string][] = [
      [undefined, 'Link unavailable'],
      [{ status: 410, body: { error: 'share_expired' } }, 'Link expired'],
      [{ status: 410, body: { error: 'share_revoked' } }, 'Link revoked'],
      [{ status: 410, body: { error: 'share_locked' } }, 'Access locked'],
    ];
    for (const [reply, title] of cases) {
      serve(reply ? { [`${BASE}/open`]: reply } : {});
      arrive();
      await screen.findByRole('heading', { name: title });
      expect(screen.queryByRole('button', { name: 'Send access code' })).toBeNull();
      cleanup();
    }
    // A link cut short, or no link at all, asks the server nothing.
    for (const hash of ['', '#t=', `#t=${ID}`, `#t=${ID}.`, '#t=short.key']) {
      window.sessionStorage.clear();
      const calls = serve({});
      arrive(hash);
      await screen.findByRole('heading', { name: 'Link unavailable' });
      expect(
        calls.filter((c) => c.path.startsWith(BASE)),
        hash,
      ).toEqual([]);
      cleanup();
    }
  });

  it('a wrong code says so and can be tried again; too many end the link', async () => {
    serve({
      [`${BASE}/open`]: { body: { ...WAITING, count: 1 } },
      [`${BASE}/code`]: [
        { body: { ok: true } },
        { status: 429, body: { error: 'code_wait' } },
        { status: 429, body: { error: 'too_many_codes' } },
      ],
      [`${BASE}/verify`]: [
        { status: 400, body: { error: 'code_wrong' } },
        { status: 400, body: { error: 'code_locked' } },
        { status: 410, body: { error: 'share_locked' } },
      ],
    });
    arrive();
    expect(await screen.findByText(/shared a document with you\. To open it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send access code' }));
    const tryCode = async (): Promise<void> => {
      fireEvent.change(await screen.findByLabelText('Access code'), {
        target: { value: '000000' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Verify code' }));
    };
    await tryCode();
    expect((await screen.findByRole('alert')).textContent).toContain('That code is not right');
    await waitFor(() =>
      expect((screen.getByLabelText('Access code') as HTMLInputElement).value).toBe(''),
    );
    await tryCode();
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Too many wrong tries'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send a new code' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Wait a minute'));
    fireEvent.click(screen.getByRole('button', { name: 'Send a new code' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Too many codes were sent'),
    );
    await tryCode();
    await screen.findByRole('heading', { name: 'Access locked' });
  });

  it('a code sent a moment ago can still be typed after the page was opened again', async () => {
    serve({
      [`${BASE}/open`]: { body: WAITING },
      [`${BASE}/code`]: { status: 429, body: { error: 'code_wait' } },
    });
    arrive();
    fireEvent.click(await screen.findByRole('button', { name: 'Send access code' }));
    expect(await screen.findByLabelText('Access code')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('A code was sent a moment ago');
  });

  it('a reload of the tab keeps the link, though the address bar no longer has it', async () => {
    const calls = serve({ [`${BASE}/open`]: { body: WAITING } });
    arrive();
    await screen.findByRole('button', { name: 'Send access code' });
    cleanup();
    arrive('');
    await screen.findByRole('button', { name: 'Send access code' });
    expect(calls.map((c) => c.body)).toEqual([{ key: KEY }, { key: KEY }]);
  });

  it('locks by itself when the verified time is over', async () => {
    const calls = serve({
      [`${BASE}/open`]: [
        { body: verified({ verifiedUntil: new Date(Date.now() + 200).toISOString() }) },
        { body: WAITING },
      ],
    });
    arrive();
    await screen.findByRole('heading', { name: 'Shared documents (2)' });
    fireEvent.click(screen.getByRole('button', { name: 'View Return-2025.pdf' }));
    expect(
      await screen.findByText(/this page locked\. Send a new code/, {}, { timeout: 4000 }),
    ).toBeTruthy();
    expect(screen.queryByTestId('pdf')).toBeNull();
    expect(screen.queryByText(/Return-2025/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send access code' })).toBeTruthy();
    expect(calls).toHaveLength(2);
  });

  it('documents the firm took down are said to be gone', async () => {
    serve({ [`${BASE}/open`]: { body: { ...WAITING, count: 0 } } });
    arrive();
    expect((await screen.findByRole('alert')).textContent).toContain('has taken down');
    expect(screen.queryByRole('button', { name: 'Send access code' })).toBeNull();
  });

  it('a portal that cannot be reached offers to try again', async () => {
    const calls: string[] = [];
    let up = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (!up) throw new TypeError('offline');
        return new Response(JSON.stringify(WAITING), { status: 200 });
      }),
    );
    arrive();
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be reached');
    up = true;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Send access code' });
    expect(calls).toHaveLength(2);
  });
});
