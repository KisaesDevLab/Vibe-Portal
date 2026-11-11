// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The firm's logo, name and colour on the pages (P53). In a file of its own: the branding is
// read once per page load, and each test file starts fresh.

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
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

  it('sign-in pages are always light, so they show the usual logo on a dark device', async () => {
    device(true);
    branding({ hasLogo: true, hasDarkLogo: true });
    const { reloadBranding } = await import('../branding');
    reloadBranding();
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByAltText('Example CPA logo').getAttribute('src')?.split('?')[0]).toBe(
        '/api/portal/branding/logo',
      ),
    );
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('a page shown dark uses the dark-mode logo even if the device query says light', async () => {
    device(false);
    document.documentElement.dataset.theme = 'dark';
    branding({ hasLogo: true, hasDarkLogo: true });
    expect(await shown()).toBe('/api/portal/branding/logo/dark');
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

describe('a pale firm colour as a link on a light page (UI review)', () => {
  it('is darkened until it reads at 4.5:1, and a dark one is left as it is', async () => {
    const { readableOnLight } = await import('../branding');
    expect(readableOnLight('#0f6cbd')).toBe('#0f6cbd');
    const pale = readableOnLight('#ffd966');
    expect(pale).not.toBe('#ffd966');
    const lum = (hex: string): number => {
      const ch = [1, 3, 5].map((i) => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
    };
    expect(1.05 / (lum(pale) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('tablets keep the native text size, so they get the wide layout (P73)', () => {
  it('zooms text from 1024 px wide only', async () => {
    const { fontScaleBootstrapScript } = await import('@vibe/ui');
    const run = (width: number): string => {
      Object.defineProperty(document.documentElement, 'clientWidth', {
        configurable: true,
        value: width,
      });
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function(fontScaleBootstrapScript)();
      return document.documentElement.style.getPropertyValue('--vibe-font-scale');
    };
    try {
      expect(run(768)).toBe('1');
      expect(run(1280)).toBe('1.15');
      // The largest step on a 1050 px window would leave 700 px: no zoom, the layout stays wide.
      localStorage.setItem('vibe-font-scale', '1.5');
      expect(run(1050)).toBe('1');
      expect(run(1280)).toBe('1.5');
      localStorage.removeItem('vibe-font-scale');
    } finally {
      document.documentElement.style.removeProperty('--vibe-font-scale');
      document.body.style.zoom = '';
    }
  });
});
