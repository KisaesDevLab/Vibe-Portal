// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The firm's logo, name and colour on the pages (P53). In a file of its own: the branding is
// read once per page load, and each test file starts fresh.

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('firm branding (P53)', () => {
  it('shows the logo and firm name on sign-in, and uses the firm colour', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/portal/branding') {
          return new Response(
            JSON.stringify({ firmName: 'Example CPA', accentColor: '#7a1f5c', hasLogo: true }),
          );
        }
        return new Response(JSON.stringify({ error: 'signed_out' }), { status: 401 });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );
    const logo = (await screen.findByAltText('Example CPA logo')) as HTMLImageElement;
    expect(logo.getAttribute('src')).toMatch(/^\/api\/portal\/branding\/logo\?v=\d+$/);
    expect(screen.getByText('Example CPA · Client portal')).toBeTruthy();
    expect(document.documentElement.style.getPropertyValue('--vibe-color-accent')).toBe('#7a1f5c');
  });
});
