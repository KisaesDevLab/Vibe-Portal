// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A form opened by a button elsewhere on the page (Share, Send securely, Access): brought into
// view and its first field focused when it appears, so pressing the button visibly does
// something, on a phone above all (UI review 2026-11-11).

import { useEffect, useRef, type ReactNode } from 'react';

export function Reveal({ children }: { children: ReactNode }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView?.({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    const first = el.querySelector<HTMLElement>(
      'input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    first?.focus({ preventScroll: true });
  }, []);
  return <div ref={ref}>{children}</div>;
}
