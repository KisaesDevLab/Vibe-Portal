// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The firm's logo, name and colour on the pages (P53). In a file of its own: the branding is
// read once per page load, and each test file starts fresh.

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

afterEach(() => {
  cleanup();
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

describe('the logo for dark mode (P60)', () => {
  function device(dark: boolean): void {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((q: string) => ({
        matches: dark && q.includes('dark'),
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
  }
  function branding(b: { hasLogo: boolean; hasDarkLogo: boolean }): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/portal/branding') {
          return new Response(
            JSON.stringify({ firmName: 'Example CPA', accentColor: '#7a1f5c', ...b }),
          );
        }
        return new Response(JSON.stringify({ error: 'signed_out' }), { status: 401 });
      }),
    );
  }
  async function shown(): Promise<string | null> {
    const { FirmLogo, reloadBranding } = await import('../branding');
    reloadBranding();
    render(<FirmLogo />);
    const img = await screen.findByAltText('Example CPA logo').catch(() => null);
    return img?.getAttribute('src')?.split('?')[0] ?? null;
  }

  it('shows the dark-mode logo on a device set to dark mode', async () => {
    device(true);
    branding({ hasLogo: true, hasDarkLogo: true });
    expect(await shown()).toBe('/api/portal/branding/logo/dark');
  });

  it('shows the usual logo in light mode', async () => {
    device(false);
    branding({ hasLogo: true, hasDarkLogo: true });
    expect(await shown()).toBe('/api/portal/branding/logo');
  });

  it('falls back to the usual logo in dark mode when there is no dark-mode logo', async () => {
    device(true);
    branding({ hasLogo: true, hasDarkLogo: false });
    expect(await shown()).toBe('/api/portal/branding/logo');
  });

  it('shows no logo in light mode when the firm has only a dark-mode one', async () => {
    device(false);
    branding({ hasLogo: false, hasDarkLogo: true });
    const { FirmLogo, reloadBranding } = await import('../branding');
    reloadBranding();
    render(<FirmLogo />);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByAltText('Example CPA logo')).toBeNull();
  });
});
