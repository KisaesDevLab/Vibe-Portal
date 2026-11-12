// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A file's kind at a glance (owner 2026-11-11, modern look): a tinted tile with an icon, PDF
// red, pictures violet, spreadsheets green, documents blue. Decoration only: the name and the
// details beside it say the same in words. And the small status badge used on the home page.

import type { ReactNode } from 'react';

type Kind = 'pdf' | 'image' | 'sheet' | 'doc' | 'other';

export function kindOf(name: string, contentType = ''): Kind {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (contentType === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (contentType.startsWith('image/') || /^(jpe?g|png|heic|heif|tiff?|gif|webp)$/.test(ext)) {
    return 'image';
  }
  if (/^(xlsx?|csv|ods)$/.test(ext) || /spreadsheet|excel|csv/.test(contentType)) return 'sheet';
  if (/^(docx?|odt|rtf|txt)$/.test(ext) || /word|text\//.test(contentType)) return 'doc';
  return 'other';
}

function Svg({ size, children }: { size: number; children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const PAGE = (
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </>
);

function KindIcon({ kind, size }: { kind: Kind; size: number }): JSX.Element {
  if (kind === 'image') {
    return (
      <Svg size={size}>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="9" cy="10" r="1.6" />
        <path d="m21 16-5-5-9 9" />
      </Svg>
    );
  }
  if (kind === 'sheet') {
    return (
      <Svg size={size}>
        {PAGE}
        <path d="M8.5 12.5h7M8.5 16h7M12 11v7" />
      </Svg>
    );
  }
  if (kind === 'pdf' || kind === 'doc') {
    return (
      <Svg size={size}>
        {PAGE}
        <path d="M9 13h6M9 16.5h6" />
      </Svg>
    );
  }
  return <Svg size={size}>{PAGE}</Svg>;
}

export function FileTile({
  name,
  contentType,
  small,
}: {
  name: string;
  contentType?: string;
  small?: boolean;
}): JSX.Element {
  const kind = kindOf(name, contentType);
  return (
    <span className={`p-tile is-${kind}${small ? ' is-small' : ''}`} aria-hidden="true">
      <KindIcon kind={kind} size={small ? 16 : 20} />
    </span>
  );
}

export function UploadIcon({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <Svg size={size}>
      <path d="M12 16V4M7 9l5-5 5 5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </Svg>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'accent' | 'success' | 'warning';
  children: ReactNode;
}): JSX.Element {
  return <span className={`p-badge${tone === 'neutral' ? '' : ` is-${tone}`}`}>{children}</span>;
}

/** A card on the home page: a heading, a line under it, and its content. */
export function Section({
  id,
  title,
  count,
  sub,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  sub?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="p-section" aria-labelledby={id}>
      <div className="p-section-head">
        <h2 id={id}>
          {title}
          {count !== undefined && count > 0 && <span className="p-count">{count}</span>}
        </h2>
        {sub && <p className="p-sub">{sub}</p>}
      </div>
      {children}
    </section>
  );
}
