// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Long lists a page at a time (P57): the staff client list, uploads, a client's files and
// secure links. Lists that are already on the page; History pages from the server instead.

import { useEffect, useState } from 'react';
import { Button } from '@vibe/ui';

export const PAGE_SIZE = 50;

/** One page of `items`, and the controls to move between pages. A change to what is listed
 *  (a search, a filter) starts again at the first page. */
export function usePages<T>(
  items: T[],
  resetOn: unknown = items.length,
  size = PAGE_SIZE,
): { slice: T[]; pager: JSX.Element | null } {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(items.length / size));
  useEffect(() => setPage(0), [resetOn]);
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
        <span>
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
