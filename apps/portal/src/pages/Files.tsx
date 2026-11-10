// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The files the firm has shared with this person for the active client: newest first, a year
// filter and a search (P19). PDFs and pictures open in the portal (P22); everything downloads.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, Pill } from '@vibe/ui';

import { usePages } from '../paging';
import { api, say } from '../api';

export interface PortalFile {
  id: string;
  name: string;
  size: number;
  contentType: string;
  taxYear: number | null;
  sharedAt: string;
  updatedAt: string | null;
  isNew: boolean;
  preview: 'pdf' | 'image' | null;
}

export const contentUrl = (id: string, mode: 'view' | 'download'): string =>
  `/api/portal/files/${id}/content?mode=${mode}`;

export function sizeText(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function dateText(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function Files({
  clientId,
  onSend,
}: {
  clientId: string;
  /** P55: when the firm allows clients to send secure links, beside each file. */
  onSend?: (f: PortalFile) => void;
}): JSX.Element {
  const [files, setFiles] = useState<PortalFile[] | null>(null);
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  // Search after a short pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(() => {
    setError('');
    const params = new URLSearchParams();
    if (year) params.set('year', year);
    if (query) params.set('q', query);
    const qs = params.toString();
    api<{ files: PortalFile[]; years: number[] }>(`/files${qs ? `?${qs}` : ''}`)
      .then((r) => {
        setFiles(r.files);
        setYears(r.years);
      })
      .catch((err: unknown) => setError(say(err)));
  }, [year, query]);

  useEffect(load, [load, clientId]);

  // Long lists a page at a time (P57).
  const { slice: page, pager } = usePages(files ?? [], `${year}|${query}|${clientId}`);

  const opened = (id: string): void =>
    setFiles((list) => list?.map((f) => (f.id === id ? { ...f, isNew: false } : f)) ?? list);

  if (error) {
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <p role="alert">{error}</p>
        <Button onClick={load}>Try again</Button>
      </div>
    );
  }
  if (!files) return <p role="status">Loading files…</p>;

  const filtering = Boolean(year || query);
  return (
    <section aria-label="Files" style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
        {years.length > 0 && (
          <label style={{ display: 'grid', gap: 4 }}>
            <span>Year</span>
            <select value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">All years</option>
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        )}
        <label style={{ display: 'grid', gap: 4, flex: '1 1 200px' }}>
          <span>Search</span>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="File name"
          />
        </label>
      </div>
      {files.length === 0 ? (
        <EmptyState
          title={filtering ? 'No files match' : 'No files yet'}
          body={
            filtering
              ? 'Try another year or search.'
              : 'Files the firm shares with you will appear here.'
          }
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
          {page.map((f) => (
            <li
              key={f.id}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                justifyContent: 'space-between',
                flexWrap: 'wrap',
                padding: '10px 0',
                borderBottom: '1px solid var(--vibe-border, #ddd)',
              }}
            >
              <div style={{ minWidth: 0, flex: '1 1 240px' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <strong style={{ overflowWrap: 'anywhere' }}>{f.name}</strong>
                  {f.isNew && <Pill tone="accent">New</Pill>}
                </div>
                <small>
                  {f.updatedAt
                    ? `Updated ${dateText(f.updatedAt)}`
                    : `Shared ${dateText(f.sharedAt)}`}
                  {f.taxYear ? ` · ${f.taxYear}` : ''} · {sizeText(f.size)}
                </small>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {f.preview && (
                  <Link
                    to={`/files/${f.id}`}
                    state={{ file: f }}
                    onClick={() => opened(f.id)}
                    aria-label={`Open ${f.name}`}
                  >
                    Open
                  </Link>
                )}
                <a
                  href={contentUrl(f.id, 'download')}
                  download={f.name}
                  onClick={() => opened(f.id)}
                  aria-label={`Download ${f.name}`}
                >
                  Download
                </a>
                {onSend && (
                  <button
                    type="button"
                    onClick={() => onSend(f)}
                    aria-label={`Send ${f.name} to someone outside`}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      color: 'inherit',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      font: 'inherit',
                    }}
                  >
                    Send securely…
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {pager}
    </section>
  );
}
