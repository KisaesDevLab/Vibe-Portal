// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

function renderAt(health: () => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(health));
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('portal shell', () => {
  it('says the portal is running when /health is ok', async () => {
    renderAt(
      async () => new Response(JSON.stringify({ status: 'ok', version: '0.1.0', db: 'ok' })),
    );
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/is running/));
  });

  it('says it cannot be reached when /health fails', async () => {
    renderAt(async () => {
      throw new Error('offline');
    });
    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toMatch(/cannot be reached/),
    );
  });
});
