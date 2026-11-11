// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The firm's name, logo and colour on every page (P53): set by an admin on the staff page
// (Settings › Firm and Logo), read once from the public /api/portal/branding.

import { useEffect, useState, type ReactNode } from 'react';
import { AuthLayout } from '@vibe/ui';

export interface Branding {
  firmName: string;
  accentColor: string;
  hasLogo: boolean;
  /** P60: a logo for dark mode (absent from older servers). */
  hasDarkLogo?: boolean;
  /** Changes when the logo may have changed, so the browser fetches it again. */
  logoVersion: number;
}

let loading: Promise<Branding | null> | null = null;
let current: Branding | null = null;
let version = 0;
const listeners = new Set<(b: Branding | null) => void>();

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The firm colour on buttons, links and focus rings (the theme's accent). */
/** Black or white, whichever reads better on `color` (WCAG relative luminance). */
export function textOn(color: string): '#000' | '#fff' {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
  // Contrast with white vs with black: pick the larger.
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#fff' : '#000';
}

function applyAccent(color: string): void {
  if (typeof document === 'undefined' || !HEX.test(color)) return;
  const root = document.documentElement.style;
  root.setProperty('--vibe-color-accent', color);
  // P59: text on the firm colour stays readable, whatever colour the firm chose.
  root.setProperty('--vibe-on-accent', textOn(color));
}

async function fetchBranding(): Promise<Branding | null> {
  try {
    const res = await fetch('/api/portal/branding', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const b = (await res.json()) as Omit<Branding, 'logoVersion'>;
    if (typeof b?.firmName !== 'string') return null;
    return { ...b, logoVersion: version };
  } catch {
    return null;
  }
}

function load(): Promise<Branding | null> {
  loading ??= fetchBranding().then((b) => {
    current = b;
    if (b) applyAccent(b.accentColor);
    for (const l of listeners) l(b);
    return b;
  });
  return loading;
}

/** Reads it again (after an admin changes the name, colour or logo on Settings). */
export function reloadBranding(): void {
  version += 1;
  loading = null;
  void load();
}

/** The firm's branding; null until it has loaded (or when it cannot be). */
export function useBranding(): Branding | null {
  const [b, setB] = useState<Branding | null>(current);
  useEffect(() => {
    listeners.add(setB);
    void load().then(setB);
    return () => {
      listeners.delete(setB);
    };
  }, []);
  return b;
}

const DARK = '(prefers-color-scheme: dark)';

function darkQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(DARK)
    : null;
}

/**
 * True while the page is shown dark. The page's own theme (`data-theme` on <html>) decides: it
 * follows the device, except that sign-in pages are always light (the design system's
 * AuthLayout), so they get the usual logo (owner 2026-11-11). The device's setting only when the
 * page has none.
 */
function pageIsDark(): boolean {
  if (typeof document !== 'undefined') {
    const t = document.documentElement.dataset.theme;
    if (t === 'light') return false;
    if (t === 'dark') return true;
  }
  return darkQuery()?.matches ?? false;
}

export function useDarkMode(): boolean {
  const [dark, setDark] = useState(pageIsDark);
  useEffect(() => {
    const again = (): void => setDark(pageIsDark());
    again();
    const m = darkQuery();
    m?.addEventListener?.('change', again);
    const watch =
      typeof MutationObserver === 'function' && typeof document !== 'undefined'
        ? new MutationObserver(again)
        : null;
    watch?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      m?.removeEventListener?.('change', again);
      watch?.disconnect();
    };
  }, []);
  return dark;
}

/**
 * The firm's logo, or nothing when it has none. P60: in dark mode, the dark-mode logo when the
 * firm set one, otherwise the usual logo. A firm with only a dark-mode logo shows none in light
 * mode (it is made for a dark background).
 */
export function FirmLogo({ height = 48 }: { height?: number }): JSX.Element | null {
  const b = useBranding();
  const dark = useDarkMode();
  const [broken, setBroken] = useState<string | null>(null);
  const path =
    dark && b?.hasDarkLogo
      ? '/api/portal/branding/logo/dark'
      : b?.hasLogo
        ? '/api/portal/branding/logo'
        : null;
  if (!b || !path || broken === path) return null;
  return (
    <img
      src={`${path}?v=${b.logoVersion}`}
      alt={`${b.firmName} logo`}
      onError={() => setBroken(path)}
      style={{ maxHeight: height, maxWidth: 240, objectFit: 'contain', display: 'block' }}
    />
  );
}

/** A sign-in or sign-up page with the firm's logo and name above `brand`. */
export function FirmAuthLayout({
  brand,
  title,
  subtitle,
  footer,
  children,
}: {
  brand: string;
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const b = useBranding();
  // "Example CPA · Client portal"; just the page's own words until the firm's name is known.
  const name = b?.firmName;
  const shown = name && name !== brand ? `${name} · ${brand}` : brand;
  return (
    <AuthLayout
      brand={shown}
      title={title}
      {...(subtitle ? { subtitle } : {})}
      {...(footer ? { footer } : {})}
      logo={b?.hasLogo || b?.hasDarkLogo ? <FirmLogo height={56} /> : undefined}
    >
      {children}
    </AuthLayout>
  );
}
