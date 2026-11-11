// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Long lists a page at a time (P57): the staff client list, uploads, a client's files and
// secure links. Lists that are already on the page; History pages from the server instead.
//
// UI review 2026-11-11: the page shown, and the search and filters of a list, are in the
// address (?page=2&q=smith), so Back, a reload or a link shared keeps them.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@vibe/ui';

export const PAGE_SIZE = 50;

/** A value kept in the address's query (`fallback` when absent, and then left out of it). */
export function useUrlState(key: string, fallback = ''): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;
  const set = useCallback(
    (v: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (!v || v === fallback) next.delete(key);
          else next.set(key, v);
          return next;
        },
        { replace: true },
      ),
    [key, fallback, setParams],
  );
  return [value, set];
}

/** A search box kept in the address: what is typed shows at once; the address (and the search)
 *  follows after a short pause, not on every key. */
export function useUrlSearch(key = 'q', delay = 300): [string, string, (v: string) => void] {
  const [q, setQ] = useUrlState(key);
  const [typed, setTyped] = useState(q);
  useEffect(() => {
    const t = window.setTimeout(() => setQ(typed.trim()), delay);
    return () => window.clearTimeout(t);
  }, [typed, setQ, delay]);
  return [typed, q, setTyped];
}

/** One page of `items`, and the controls to move between pages. A change to what is listed
 *  (a search, a filter: `resetOn`) starts again at the first page. `param` names the page in
 *  the address, different for two lists on one page. */
export function usePages<T>(
  items: T[],
  resetOn: unknown = '',
  size = PAGE_SIZE,
  param = 'page',
): { slice: T[]; pager: JSX.Element | null } {
  const [raw, setRaw] = useUrlState(param, '1');
  const page = Math.max(0, (Number.parseInt(raw, 10) || 1) - 1);
  const setPage = (n: number): void => setRaw(String(n + 1));
  const pages = Math.max(1, Math.ceil(items.length / size));
  // Only when what is listed changes: on the first showing (and React's second run of it in
  // development) the page in the address is kept.
  const listed = useRef(resetOn);
  useEffect(() => {
    if (Object.is(listed.current, resetOn)) return;
    listed.current = resetOn;
    setRaw('1');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetOn]);
  const at = Math.min(page, pages - 1);
  const slice = items.slice(at * size, at * size + size);
  if (items.length <= size) return { slice, pager: null };
  const from = at * size + 1;
  const to = Math.min(items.length, at * size + size);
  return {
    slice,
    pager: (
      <nav
        aria-label="Pages"
        style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' }}
      >
        <Button size="sm" variant="secondary" disabled={at === 0} onClick={() => setPage(at - 1)}>
          Previous
        </Button>
        <span aria-live="polite" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {from}–{to} of {items.length}
        </span>
        <Button
          size="sm"
          variant="secondary"
          disabled={at >= pages - 1}
          onClick={() => setPage(at + 1)}
        >
          Next
        </Button>
      </nav>
    ),
  };
}
