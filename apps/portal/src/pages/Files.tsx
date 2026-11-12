// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The files the firm has shared with this person for the active client: newest first, a year
// filter and a search (P19). PDFs and pictures open in the portal (P22); everything downloads.

import { useCallback, useEffect, useState } from 'react';
import { Button, Download, EmptyState, Eye, ShareIcon } from '@vibe/ui';

import { ActionButton, ActionDownload, ActionLink, Actions, ItemRow } from '../components/Action';
import { SearchField, Select } from '../components/Field';
import { Badge, FileTile } from '../components/FileKind';
import { usePages, useUrlState } from '../paging';
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

export function dateText(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function Files({
  clientId,
  onSend,
  onCount,
}: {
  clientId: string;
  /** How many files there are (shown beside the heading). */
  onCount?: (n: number) => void;
  /** P55: when the firm allows clients to send secure links, beside each file. */
  onSend?: (f: PortalFile) => void;
}): JSX.Element {
  const [files, setFiles] = useState<PortalFile[] | null>(null);
  const [yearRaw, setYear] = useUrlState('year');
  // A year from an old link that this client has no files of: every year (never stuck empty).
  const [years, setYears] = useState<number[] | null>(null);
  const year = yearRaw && years && !years.includes(Number(yearRaw)) ? '' : yearRaw;
  const [query, setQuery] = useUrlState('q');
  const [search, setSearch] = useState(query);
  const [error, setError] = useState('');

  // Search after a short pause in typing.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search, setQuery]);

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
        if (!params.toString()) onCount?.(r.files.length);
      })
      .catch((err: unknown) => setError(say(err)));
  }, [year, query, onCount]);

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
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
        <div style={{ flex: '1 1 220px' }}>
          <SearchField
            label="Search"
            name="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="File name"
          />
        </div>
        {years && years.length > 0 && (
          <div style={{ flex: '0 1 160px' }}>
            <Select label="Year" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">All years</option>
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
        )}
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
        <ul className="p-list">
          {page.map((f) => (
            <ItemRow
              key={f.id}
              bare
              icon={<FileTile name={f.name} contentType={f.contentType} />}
              title={f.name}
              badge={f.isNew ? <Badge tone="accent">New</Badge> : undefined}
              meta={
                <>
                  {f.updatedAt
                    ? `Updated ${dateText(f.updatedAt)}`
                    : `Shared ${dateText(f.sharedAt)}`}
                  {f.taxYear ? ` · ${f.taxYear}` : ''} · {sizeText(f.size)}
                </>
              }
              actions={
                <Actions>
                  {f.preview && (
                    <ActionLink
                      tone="blue"
                      to={`/files/${f.id}`}
                      state={{ file: f }}
                      onClick={() => opened(f.id)}
                      ariaLabel={`Open ${f.name}`}
                      icon={<Eye size={16} />}
                      label="Open"
                    />
                  )}
                  <ActionDownload
                    tone="green"
                    href={contentUrl(f.id, 'download')}
                    filename={f.name}
                    onClick={() => opened(f.id)}
                    ariaLabel={`Download ${f.name}`}
                    icon={<Download size={16} />}
                    label="Download"
                  />
                  {onSend && (
                    <ActionButton
                      tone="violet"
                      onClick={() => onSend(f)}
                      ariaLabel={`Send ${f.name} to someone outside`}
                      icon={<ShareIcon size={16} />}
                      label="Share"
                    />
                  )}
                </Actions>
              }
            />
          ))}
        </ul>
      )}
      {pager}
    </div>
  );
}
