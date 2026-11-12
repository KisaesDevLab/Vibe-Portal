// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P77: a client's portal as its people see it, for staff, read only (owner 2026-11-12). Opened
// in a new tab from the client's staff page. The same look as the client's home: the firm's
// bar, the client's name, its link (P76), its files. Files open view only; nothing downloads,
// is shared, sent or removed. A person sees only the files shared with them: the preview lists
// those someone at the client can see, and says so.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Button, Download, EmptyState, Eye, ShareIcon, ThemeToggle } from '@vibe/ui';

import { ApiError } from '../api';
import { FirmLogo } from '../branding';
import { ActionButton, Actions, ItemRow } from '../components/Action';
import { ClientLinkBanner } from '../components/ClientBanner';
import { SearchField } from '../components/Field';
import { Badge, FileTile, Section, UploadIcon } from '../components/FileKind';
import { ProtectedPdfViewer } from '../components/ProtectedPdfViewer';
import { dateText, sizeText, type PortalFile } from '../pages/Files';
import { staffApi, staffSay } from './api';

interface Preview {
  firmName: string;
  client: { id: string; name: string; active: boolean };
  people: number;
  link: { url: string; message: string; button: string } | null;
  files: PortalFile[];
}

const NOT_HERE = 'Not in the preview';

export function ClientPreview(): JSX.Element {
  const { id = '' } = useParams();
  const [data, setData] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<PortalFile | null>(null);
  const [q, setQ] = useState('');
  /** What was pressed that does nothing in the preview, said in the bar. */
  const [pressed, setPressed] = useState('');
  const notHere = (what: string): void => setPressed(`${what} does nothing in the preview.`);

  useEffect(() => {
    staffApi<Preview>(`/v1/clients/${encodeURIComponent(id)}/preview`)
      .then(setData)
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.status === 401
            ? 'Your staff session has ended. Sign in on the staff page, then open the preview again.'
            : staffSay(err),
        );
      });
  }, [id]);

  useEffect(() => {
    if (data) document.title = `Preview: ${data.client.name} · ${data.firmName}`;
  }, [data]);

  if (!data) {
    return (
      <main id="main-content" tabIndex={-1} className="p-page">
        {error ? <p role="alert">{error}</p> : <p role="status">Loading the preview…</p>}
      </main>
    );
  }

  const content = (f: PortalFile): string =>
    `/api/staff/v1/clients/${encodeURIComponent(id)}/preview/files/${encodeURIComponent(f.id)}/content`;
  const shown = data.files.filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="p-preview-bar" role="note">
        <div className="p-preview-inner">
          <p>
            <strong>Preview of {data.client.name}’s portal.</strong> Read only: files open, other
            buttons do nothing. It lists the files someone at this client can see ({data.people}{' '}
            {data.people === 1 ? 'person' : 'people'}); each person sees only the files shared with
            them.
          </p>
          <p role="status" style={{ flex: pressed ? '1 1 100%' : '0 0 0', fontWeight: 600 }}>
            {pressed}
          </p>
          <Button variant="secondary" size="sm" onClick={() => window.close()}>
            Close preview
          </Button>
        </div>
      </div>
      <header className="p-topbar">
        <div className="p-topbar-inner">
          <div className="p-brand">
            <FirmLogo height={36} />
            <span>{data.firmName}</span>
          </div>
          <div className="p-account">
            <ThemeToggle />
            <Button
              variant="secondary"
              size="sm"
              aria-label={`Sign out (${NOT_HERE.toLowerCase()})`}
              onClick={() => notHere('Sign out')}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="p-page">
        <div className="p-intro">
          <div style={{ minWidth: 0 }}>
            <h1>{data.client.name}</h1>
            <p className="p-sub">Signed in as (the person’s name).</p>
          </div>
        </div>
        {data.link && <ClientLinkBanner link={data.link} />}
        <Section
          id="files-heading"
          title="Files from the firm"
          count={data.files.length}
          sub={`Shared with you by ${data.firmName}. PDFs and pictures open here; everything downloads.`}
        >
          {viewing ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <Button variant="secondary" size="sm" onClick={() => setViewing(null)}>
                  ← All files
                </Button>
              </div>
              <h3 style={{ margin: 0, fontSize: 16, overflowWrap: 'anywhere' }}>{viewing.name}</h3>
              {viewing.preview === 'pdf' ? (
                <ProtectedPdfViewer
                  url={content(viewing)}
                  canDownload={false}
                  filename={viewing.name}
                />
              ) : (
                <img
                  src={content(viewing)}
                  alt={viewing.name}
                  style={{ maxWidth: '100%', height: 'auto' }}
                />
              )}
            </div>
          ) : (
            <>
              <SearchField
                label="Search"
                name="search"
                value={q}
                placeholder="File name"
                onChange={(e) => setQ(e.target.value)}
              />
              {shown.length === 0 ? (
                <EmptyState
                  title={q.trim() ? 'No files match' : 'No files yet'}
                  body={
                    q.trim()
                      ? 'Try another search.'
                      : 'No file here is shared with anyone at this client yet.'
                  }
                />
              ) : (
                <ul className="p-list">
                  {shown.map((f) => (
                    <ItemRow
                      key={f.id}
                      bare
                      icon={<FileTile name={f.name} contentType={f.contentType} />}
                      title={f.name}
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
                            <ActionButton
                              tone="blue"
                              onClick={() => setViewing(f)}
                              ariaLabel={`Open ${f.name}`}
                              icon={<Eye size={16} />}
                              label="Open"
                            />
                          )}
                          <ActionButton
                            tone="green"
                            onClick={() => notHere('Download')}
                            ariaLabel={`Download ${f.name} (${NOT_HERE.toLowerCase()})`}
                            icon={<Download size={16} />}
                            label="Download"
                          />
                          <ActionButton
                            tone="violet"
                            onClick={() => notHere('Share')}
                            ariaLabel={`Share ${f.name} (${NOT_HERE.toLowerCase()})`}
                            icon={<ShareIcon size={16} />}
                            label="Share"
                          />
                        </Actions>
                      }
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </Section>
        <Section
          id="send-heading"
          title="Send files to the firm"
          sub="Tax documents, statements, receipts: anything the firm asked for."
        >
          <div className="p-drop" aria-disabled="true" style={{ cursor: 'default' }}>
            <span className="p-drop-icon">
              <UploadIcon />
            </span>
            <span>
              <span className="p-drop-choose">Choose files</span> or drag them here
            </span>
            <small>Each person sends their files here ({NOT_HERE.toLowerCase()}).</small>
          </div>
        </Section>
        <Section
          id="uploads-heading"
          title="Your uploads"
          sub="A file can be removed until the firm has received it."
        >
          <EmptyState
            title="Each person sees the files they sent."
            body={
              <>
                Their uploads are on the client’s staff page, with a{' '}
                <Badge>Waiting for the firm</Badge> or <Badge tone="success">Received</Badge> mark
                on the portal.
              </>
            }
            style={{ padding: '8px 16px 12px' }}
          />
        </Section>
      </main>
    </>
  );
}
