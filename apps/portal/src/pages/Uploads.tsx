// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Send files to the firm (Phase 4): up to 20 at a time with one optional note (P30, P34),
// sent one after another with progress. "Your uploads" shows what was sent; a file can be
// removed until the firm has received it (P32).

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@vibe/ui';

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
): Promise<{ uploadId: string; name: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
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
  const [chosen, setChosen] = useState<File[]>([]);
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState('');
  const [results, setResults] = useState<{ name: string; error?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api<{ uploads: Upload[] }>('/uploads')
      .then((r) => setUploads(r.uploads))
      .catch((err: unknown) => setError(say(err)));
  }, []);
  useEffect(load, [load, clientId]);

  async function send(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (chosen.length === 0 || chosen.length > BATCH_MAX) return;
    setBusy(true);
    setResults([]);
    const batchId = newBatchId();
    const done: { name: string; error?: string }[] = [];
    for (const [i, file] of chosen.entries()) {
      const q = new URLSearchParams({ clientId, batchId, name: file.name });
      if (note.trim()) q.set('note', note.trim());
      try {
        await sendFile(`/api/portal/uploads?${q.toString()}`, file, (f) =>
          setProgress(
            `Sending ${i + 1} of ${chosen.length}: ${file.name} (${Math.round(f * 100)}%)`,
          ),
        );
        done.push({ name: file.name });
      } catch (err) {
        done.push({ name: file.name, error: say(err) });
      }
      setResults([...done]);
    }
    setProgress('');
    setBusy(false);
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
  return (
    <section aria-label="Send files to the firm" style={{ display: 'grid', gap: 12 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Send files to the firm</h2>
      <form onSubmit={send} style={{ display: 'grid', gap: 8 }}>
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Files (up to {BATCH_MAX}: PDF, photos, Word, Excel, CSV or text)</span>
          <input
            ref={input}
            type="file"
            multiple
            accept={ACCEPT}
            onChange={(e) => setChosen(Array.from(e.target.files ?? []))}
          />
        </label>
        {tooMany && <p role="alert">Choose at most {BATCH_MAX} files at a time.</p>}
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Note for the firm (optional)</span>
          <textarea
            value={note}
            maxLength={1000}
            rows={2}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <Button type="submit" disabled={busy || chosen.length === 0 || tooMany}>
          {chosen.length > 1 ? `Send ${chosen.length} files` : 'Send'}
        </Button>
        {progress && <p role="status">{progress}</p>}
        {results.length > 0 && (
          <ul aria-label="Sent" style={{ margin: 0 }}>
            {results.map((r, i) => (
              <li key={i}>
                {r.name}: {r.error ? <span role="alert">{r.error}</span> : 'sent'}
              </li>
            ))}
          </ul>
        )}
      </form>

      <h3 style={{ fontSize: 14, margin: 0 }}>Your uploads</h3>
      {error && <p role="alert">{error}</p>}
      {uploads === null ? (
        <p role="status">Loading…</p>
      ) : uploads.length === 0 ? (
        <p>You have not sent any files yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {uploads.map((u) => (
            <li
              key={u.id}
              style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <span style={{ overflowWrap: 'anywhere' }}>{u.name}</span>
              <small>{new Date(u.uploadedAt).toLocaleDateString()}</small>
              {u.received ? (
                <small>Received by the firm</small>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void remove(u.id)}
                  aria-label={`Remove ${u.name}`}
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
