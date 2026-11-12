// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Send files to the firm (Phase 4): up to 20 at a time with one optional note (P30, P34),
// sent one after another with progress. "Your uploads" shows what was sent; a file can be
// removed until the firm has received it (P32).

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Button, CloseIcon, EmptyState, Trash } from '@vibe/ui';

import { ActionButton, Actions, ItemRow } from '../components/Action';
import { Select, TextArea } from '../components/Field';
import { Badge, FileTile, Section, UploadIcon } from '../components/FileKind';
import { dateText, sizeText } from './Files';

import { api, ApiError, say } from '../api';

export const ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.tif,.tiff,.doc,.docx,.xls,.xlsx,.csv,.txt';
export const BATCH_MAX = 20;

interface Upload {
  id: string;
  name: string;
  size: number;
  note: string;
  uploadedAt: string;
  received: boolean;
}

/** Sends one file with progress (fetch cannot report upload progress). */
export function sendFile(
  url: string,
  file: Blob,
  onProgress: (fraction: number) => void,
  text: { name: string; note?: string },
): Promise<{ uploadId: string; name: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    // In headers, not the URL, so the proxy's access log does not keep them (P47).
    xhr.setRequestHeader('X-Vibe-Name', encodeURIComponent(text.name));
    if (text.note) xhr.setRequestHeader('X-Vibe-Note', encodeURIComponent(text.note));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: { error?: string; uploadId?: string; name?: string } = {};
      try {
        data = JSON.parse(xhr.responseText) as typeof data;
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.uploadId) {
        resolve({ uploadId: data.uploadId, name: data.name ?? '' });
      } else reject(new ApiError(xhr.status, data.error ?? 'error'));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network'));
    xhr.send(file);
  });
}

function newBatchId(): string {
  return crypto.randomUUID();
}

export function Uploads({ clientId }: { clientId: string }): JSX.Element {
  const [uploads, setUploads] = useState<Upload[] | null>(null);
  const [limitBytes, setLimitBytes] = useState(0);
  const [chosen, setChosen] = useState<File[]>([]);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<{ label: string; pct: number } | null>(null);
  const [results, setResults] = useState<{ name: string; error?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  /** Staff the client may tell about what they send (P56); none: the choice is not shown. */
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [tell, setTell] = useState('');
  const [told, setTold] = useState('');
  const [over, setOver] = useState(false);

  /** Files chosen or dropped are added to the list (the same file once). */
  const add = (list: File[]): void => {
    setResults([]);
    setTold('');
    setChosen((had) => [
      ...had,
      ...list.filter(
        (f) =>
          !had.some(
            (h) => h.name === f.name && h.size === f.size && h.lastModified === f.lastModified,
          ),
      ),
    ]);
  };
  const [skipped, setSkipped] = useState<string[]>([]);
  const drop = (e: DragEvent): void => {
    e.preventDefault();
    setOver(false);
    if (busy) return;
    // The chooser offers only these kinds; a dropped file is held to the same.
    const kinds = ACCEPT.split(',');
    const all = Array.from(e.dataTransfer.files);
    const ok = all.filter((f) => kinds.some((k) => f.name.toLowerCase().endsWith(k)));
    setSkipped(all.filter((f) => !ok.includes(f)).map((f) => f.name));
    add(ok);
  };

  useEffect(() => {
    setTell('');
    api<{ staff: { id: string; name: string }[] }>(
      `/uploads/notify-options?clientId=${encodeURIComponent(clientId)}`,
    )
      .then((r) => setStaff(r.staff))
      .catch(() => setStaff([]));
  }, [clientId]);

  const load = useCallback(() => {
    api<{ uploads: Upload[]; limitBytes?: number }>('/uploads')
      .then((r) => {
        setUploads(r.uploads);
        setLimitBytes(r.limitBytes ?? 0);
      })
      .catch((err: unknown) => setError(say(err)));
  }, []);
  useEffect(load, [load, clientId]);

  async function send(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (chosen.length === 0 || chosen.length > BATCH_MAX) return;
    setBusy(true);
    setResults([]);
    setTold('');
    const batchId = newBatchId();
    const done: { name: string; error?: string }[] = [];
    for (const [i, file] of chosen.entries()) {
      const q = new URLSearchParams({ clientId, batchId });
      if (limitBytes > 0 && file.size > limitBytes) {
        done.push({
          name: file.name,
          error: `This file is too large to send (the limit is ${Math.floor(limitBytes / 1048576)} MB).`,
        });
        setResults([...done]);
        continue;
      }
      try {
        await sendFile(
          `/api/portal/uploads?${q.toString()}`,
          file,
          (f) =>
            setProgress({
              label: `Sending ${i + 1} of ${chosen.length}: ${file.name}`,
              pct: Math.round(f * 100),
            }),
          { name: file.name, note: note.trim() || undefined },
        );
        done.push({ name: file.name });
      } catch (err) {
        done.push({ name: file.name, error: say(err) });
      }
      setResults([...done]);
    }
    setProgress(null);
    // P56: tell the chosen person once, if anything arrived.
    const who = staff.find((p) => p.id === tell);
    if (who && done.some((d) => !d.error)) {
      try {
        await api('/uploads/notify', {
          method: 'POST',
          body: { clientId, batchId, staffId: who.id },
        });
        setTold(`${who.name} has been told.`);
      } catch (err) {
        setTold(`Your files were sent, but ${who.name} could not be told: ${say(err)}`);
      }
    }
    setBusy(false);
    setSkipped([]);
    setChosen([]);
    setNote('');
    if (input.current) input.current.value = '';
    load();
  }

  async function remove(id: string): Promise<void> {
    setError('');
    try {
      await api(`/uploads/${id}`, { method: 'DELETE' });
    } catch (err) {
      setError(say(err));
    }
    load();
  }

  const tooMany = chosen.length > BATCH_MAX;
  const mb = limitBytes > 0 ? Math.floor(limitBytes / 1048576) : 0;
  return (
    <>
      <Section
        id="send-heading"
        title="Send files to the firm"
        sub="Tax documents, statements, receipts: anything the firm asked for."
      >
        <form onSubmit={send} style={{ display: 'grid', gap: 16 }}>
          {/* The whole area opens the file chooser; files can also be dropped on it. */}
          <label
            className={`p-drop${over ? ' is-over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={drop}
          >
            <span className="p-drop-icon">
              <UploadIcon />
            </span>
            <span>
              <span className="p-drop-choose">Choose files</span> or drag them here
            </span>
            <small>
              Up to {BATCH_MAX} at a time: PDF, photos, Word, Excel, CSV or text
              {mb ? `, ${mb} MB each at most` : ''}
            </small>
            <input
              ref={input}
              className="visually-hidden"
              type="file"
              multiple
              accept={ACCEPT}
              disabled={busy}
              aria-label={`Files (up to ${BATCH_MAX}: PDF, photos, Word, Excel, CSV or text)`}
              onChange={(e) => {
                setSkipped([]);
                add(Array.from(e.target.files ?? []));
                // The same file can be chosen again after it is taken off the list.
                e.target.value = '';
              }}
            />
          </label>
          {chosen.length > 0 && (
            <ul className="p-list" aria-label="Files to send">
              {chosen.map((c, i) => (
                <li
                  key={`${c.name}-${c.size}-${c.lastModified}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}
                >
                  <FileTile name={c.name} contentType={c.type} small />
                  <span style={{ flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}>
                    {c.name}
                    <span className="p-sub" style={{ fontSize: 13 }}>
                      {' '}
                      · {sizeText(c.size)}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Take ${c.name} off the list`}
                    onClick={() => setChosen((l) => l.filter((_, k) => k !== i))}
                  >
                    <CloseIcon size={16} />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {skipped.length > 0 && (
            <p role="alert" style={{ overflowWrap: 'anywhere' }}>
              Not added (the portal does not take this kind of file): {skipped.join(', ')}
            </p>
          )}
          <p role="status" className="visually-hidden">
            {chosen.length === 0
              ? ''
              : `${chosen.length} ${chosen.length === 1 ? 'file' : 'files'} chosen`}
          </p>
          {tooMany && <p role="alert">Choose at most {BATCH_MAX} files at a time.</p>}
          {chosen.length > 0 && (
            <>
              <div className={staff.length > 0 ? 'p-form-grid' : undefined}>
                <TextArea
                  label="Note for the firm (optional)"
                  value={note}
                  maxLength={1000}
                  rows={2}
                  onChange={(e) => setNote(e.target.value)}
                />
                {staff.length > 0 && (
                  <Select
                    label="Let someone at the firm know (optional)"
                    value={tell}
                    onChange={(e) => setTell(e.target.value)}
                  >
                    <option value="">No one in particular</option>
                    {staff.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
              <div className="p-form-end">
                <Button type="submit" disabled={busy || tooMany} style={{ minWidth: 160 }}>
                  {busy ? 'Sending…' : chosen.length > 1 ? `Send ${chosen.length} files` : 'Send'}
                </Button>
              </div>
            </>
          )}
          {progress && (
            <div style={{ display: 'grid', gap: 4 }}>
              {/* Announced when a new file starts; the bar shows how far (not read out). */}
              <p role="status" style={{ margin: 0, overflowWrap: 'anywhere' }}>
                {progress.label}
              </p>
              <progress
                value={progress.pct}
                max={100}
                aria-label={`${progress.label}, ${progress.pct}%`}
                style={{ width: '100%' }}
              />
            </div>
          )}
          {told && <p role="status">{told}</p>}
          {results.length > 0 && (
            <ul aria-label="Sent" style={{ margin: 0, paddingLeft: 20 }}>
              {results.map((r, i) => (
                <li key={i} style={{ overflowWrap: 'anywhere' }}>
                  {r.name}: {r.error ? <span role="alert">{r.error}</span> : 'sent'}
                </li>
              ))}
            </ul>
          )}
        </form>
      </Section>

      <Section
        id="uploads-heading"
        title="Your uploads"
        sub="A file can be removed until the firm has received it."
      >
        {error && <p role="alert">{error}</p>}
        {uploads === null ? (
          <p role="status">Loading…</p>
        ) : uploads.length === 0 ? (
          <EmptyState
            title="You have not sent any files yet."
            body="Files you send appear here, with whether the firm has them."
            style={{ padding: '8px 16px 12px' }}
          />
        ) : (
          <ul className="p-list">
            {uploads.map((u) => (
              <ItemRow
                key={u.id}
                bare
                icon={<FileTile name={u.name} />}
                title={u.name}
                badge={
                  u.received ? (
                    <Badge tone="success">Received</Badge>
                  ) : (
                    <Badge>Waiting for the firm</Badge>
                  )
                }
                meta={`Sent ${dateText(u.uploadedAt)}`}
                actions={
                  u.received ? undefined : (
                    <Actions>
                      <ActionButton
                        tone="red"
                        onClick={() => void remove(u.id)}
                        ariaLabel={`Remove ${u.name}`}
                        icon={<Trash size={16} />}
                        label="Remove"
                      />
                    </Actions>
                  )
                }
              />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
