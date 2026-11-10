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
  /** Changes when the logo may have changed, so the browser fetches it again. */
  logoVersion: number;
}

let loading: Promise<Branding | null> | null = null;
let current: Branding | null = null;
let version = 0;
const listeners = new Set<(b: Branding | null) => void>();

const HEX = /^#[0-9a-fA-F]{6}$/;

/** The firm colour on buttons, links and focus rings (the theme's accent). */
function applyAccent(color: string): void {
  if (typeof document === 'undefined' || !HEX.test(color)) return;
  document.documentElement.style.setProperty('--vibe-color-accent', color);
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

/** The firm's logo, or nothing when it has none. */
export function FirmLogo({ height = 48 }: { height?: number }): JSX.Element | null {
  const b = useBranding();
  const [broken, setBroken] = useState(false);
  if (!b?.hasLogo || broken) return null;
  return (
    <img
      src={`/api/portal/branding/logo?v=${b.logoVersion}`}
      alt={`${b.firmName} logo`}
      onError={() => setBroken(true)}
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
      logo={b?.hasLogo ? <FirmLogo height={56} /> : undefined}
    >
      {children}
    </AuthLayout>
  );
}
