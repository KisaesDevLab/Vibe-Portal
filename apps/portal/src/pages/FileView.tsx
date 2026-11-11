// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// One file opened in the portal: a PDF in the PDF viewer, or a picture (P22).

import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';

import { api, ApiError, say } from '../api';
import { ProtectedPdfViewer } from '../components/ProtectedPdfViewer';
import { contentUrl, type PortalFile } from './Files';

export function FileView(): JSX.Element {
  const { id = '' } = useParams();
  const location = useLocation();
  const passed = (location.state as { file?: PortalFile } | null)?.file;
  const [file, setFile] = useState<PortalFile | null>(passed?.id === id ? passed : null);
  const [error, setError] = useState('');
  const [signedOut, setSignedOut] = useState(false);

  useEffect(() => {
    if (file) return;
    // Opened from a bookmark: find the file in the list.
    api<{ files: PortalFile[] }>('/files')
      .then((r) => {
        const f = r.files.find((x) => x.id === id);
        if (f) setFile(f);
        else setError('This file is no longer shared with you.');
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setSignedOut(true);
        else setError(say(err));
      });
  }, [file, id]);

  if (signedOut) return <Navigate to="/login" replace />;

  return (
    <main
      id="main-content"
      style={{ maxWidth: 960, margin: '0 auto', padding: 16, display: 'grid', gap: 12 }}
    >
      <nav>
        <Link to="/">← All files</Link>
      </nav>
      {error && <p role="alert">{error}</p>}
      {!error && !file && <p role="status">Loading…</p>}
      {file && (
        <>
          <h1 style={{ fontSize: 18, margin: 0, overflowWrap: 'anywhere' }}>{file.name}</h1>
          {file.preview === 'pdf' && (
            <ProtectedPdfViewer
              url={contentUrl(file.id, 'view')}
              downloadUrl={contentUrl(file.id, 'download')}
              canDownload
              filename={file.name}
            />
          )}
          {file.preview === 'image' && (
            <>
              <img
                src={contentUrl(file.id, 'view')}
                alt={file.name}
                style={{ maxWidth: '100%', height: 'auto' }}
              />
              <a href={contentUrl(file.id, 'download')} download={file.name}>
                Download
              </a>
            </>
          )}
          {!file.preview && (
            <a href={contentUrl(file.id, 'download')} download={file.name}>
              Download {file.name}
            </a>
          )}
        </>
      )}
    </main>
  );
}
