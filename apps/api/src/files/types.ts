// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// File types and download headers. Only PDFs and JPG/PNG pictures open in the browser (P22);
// everything else downloads.

const BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

export function contentTypeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return BY_EXT[ext] ?? 'application/octet-stream';
}

export type Preview = 'pdf' | 'image' | null;

export function previewOf(contentType: string): Preview {
  if (contentType === 'application/pdf') return 'pdf';
  if (contentType === 'image/png' || contentType === 'image/jpeg') return 'image';
  return null;
}

/** A file name fit to keep: no folders, no control characters, at most 200 characters. */
export function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return name.slice(0, 200) || 'file';
}

/** Content-Disposition with a plain fallback name and the full UTF-8 name (RFC 6266). */
export function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
