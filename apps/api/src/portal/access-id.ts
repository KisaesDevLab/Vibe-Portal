// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P67: the photo ID sent with an access request (a driver's license, state ID or passport).
//
// - Stored encrypted with the firm key, like an upload (and in B2 when files are there).
// - Shown to the staff who decide requests (those who see every client).
// - On approval, a PDF of the request and its photo ID goes to Vibe Files' Portal inbox as an
//   upload of the first client, named "Access request - <name>.pdf" (Vibe Files puts the
//   client's name and code in front). The client never sees it among their uploads.
// - Deleted 7 days after Vibe Files fetched the record (it fetches only once the checksum
//   matches), the portal's copy of the PDF too; a denied request's 30 days after the decision;
//   an unconfirmed request's with the request.

import { Readable } from 'node:stream';

import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { generateKey } from '@vibe/crypto';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { schema } from '@vibe-portal/db';

import type { Ctx } from '../context';
import { TooLarge } from '../files/blobs';
import { convertHeicQueued, HEIC_MAX_BYTES } from '../files/heic';
import { peek } from '../files/send';
import { allowedKind, SNIFF_BYTES } from '../files/sniff';
import { HttpError } from '../lib/http';

/** A phone photo or a scan: plenty for an ID, small enough to hold while converting. */
export const ID_MAX_BYTES = 15 * 1024 * 1024;
/** Days a denied request's ID is kept (owner 2026-11-11). */
export const ID_KEEP_DAYS = 30;
/** An unconfirmed request is deleted after 7 days (housekeeping): its ID goes a day before. */
const UNCONFIRMED_ID_DAYS = 6;
const DAY = 24 * 3_600_000;

type Request = typeof schema.accessRequest.$inferSelect;
const TYPES = { jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' } as const;

/**
 * Stores the photo ID for a request still waiting for its code, replacing one sent before.
 * JPEG, PNG or PDF; a phone's HEIC photo is converted to JPEG.
 */
export async function storeIdPhoto(
  ctx: Ctx,
  request: Request,
  body: Readable,
  name: string,
  convertHeic: (b: Buffer) => Promise<Buffer> = convertHeicQueued,
): Promise<{ contentType: string; size: number }> {
  const { head, all } = await peek(body, SNIFF_BYTES);
  const kind = allowedKind(head.subarray(0, SNIFF_BYTES), name);
  if (kind !== 'jpeg' && kind !== 'png' && kind !== 'pdf' && kind !== 'heic') {
    throw new HttpError(415, 'id_type');
  }
  let source: Readable = all;
  let contentType: string = kind === 'heic' ? TYPES.jpeg : TYPES[kind];
  if (kind === 'heic') {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const c of all) {
      size += (c as Buffer).length;
      if (size > Math.min(ID_MAX_BYTES, HEIC_MAX_BYTES)) throw new HttpError(413, 'too_large');
      parts.push(c as Buffer);
    }
    try {
      source = Readable.from([await convertHeic(Buffer.concat(parts))]);
    } catch (err) {
      ctx.log.warn({ err }, 'photo ID: heic conversion failed');
      throw new HttpError(415, 'photo_unreadable');
    }
    contentType = TYPES.jpeg;
  }
  const dek = generateKey();
  let stored;
  try {
    stored = await ctx.blobs.put(source, dek, ID_MAX_BYTES);
  } catch (err) {
    if (err instanceof TooLarge) throw new HttpError(413, 'too_large');
    throw err;
  }
  await ctx.db
    .update(schema.accessRequest)
    .set({
      idBlobKey: stored.blobKey,
      idDekWrapped: Buffer.from(ctx.keyring.wrap(dek)),
      idContentType: contentType,
      idSize: stored.size,
      idRemovedAt: null,
    })
    .where(eq(schema.accessRequest.id, request.id));
  if (request.idBlobKey) await ctx.blobs.remove(request.idBlobKey).catch(() => false);
  return { contentType, size: stored.size };
}

/** The photo ID's bytes and type, or null when there is none (never sent, or removed). */
export async function readIdPhoto(
  ctx: Ctx,
  request: Pick<Request, 'id' | 'idBlobKey' | 'idDekWrapped' | 'idContentType'>,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!request.idBlobKey || !request.idDekWrapped) return null;
  try {
    const bytes = await ctx.blobs.read(
      request.idBlobKey,
      ctx.keyring.unwrap(new Uint8Array(request.idDekWrapped)),
    );
    return { bytes, contentType: request.idContentType ?? 'application/octet-stream' };
  } catch (err) {
    ctx.log.error({ err, id: request.id }, 'photo ID failed to decrypt');
    throw new HttpError(500, 'file_unreadable');
  }
}

/** Days the photo ID and the portal's copy of the record are kept once Vibe Files has fetched
 *  the record (owner 2026-11-11). */
export const FETCHED_KEEP_DAYS = 7;

/**
 * Removes photo IDs past their time (run hourly):
 * - approved: 7 days after Vibe Files fetched the record PDF; the portal's copy of the PDF goes
 *   too. Kept until then, however long, so the ID is never lost before the firm has it.
 *   (Approved without a record, when it could not be made: 30 days, as a denial.)
 * - denied: 30 days after the decision.
 * - never confirmed: before housekeeping deletes the request.
 */
export async function purgeIdPhotos(ctx: Ctx): Promise<number> {
  const now = ctx.now();
  const ago = (days: number): Date => new Date(now.getTime() - days * DAY);
  const records = await ctx.db
    .select({
      requestId: schema.uploads.accessRequestId,
      uploadId: schema.uploads.id,
      blobKey: schema.uploads.blobKey,
      fetchedAt: schema.uploads.fetchedAt,
    })
    .from(schema.uploads)
    .where(isNotNull(schema.uploads.accessRequestId));
  const fetchedLongAgo = new Set(
    records
      .filter((r) => r.fetchedAt && r.fetchedAt < ago(FETCHED_KEEP_DAYS))
      .map((r) => r.requestId),
  );
  const hasRecord = new Set(records.map((r) => r.requestId));
  // The portal's copy of a fetched record.
  for (const r of records) {
    if (r.blobKey && r.fetchedAt && r.fetchedAt < ago(FETCHED_KEEP_DAYS)) {
      const [done] = await ctx.db
        .update(schema.uploads)
        .set({ purgedAt: now, blobKey: null, dekWrapped: null })
        .where(and(eq(schema.uploads.id, r.uploadId), isNull(schema.uploads.purgedAt)))
        .returning({ id: schema.uploads.id });
      if (done) await ctx.blobs.remove(r.blobKey);
    }
  }
  const held = await ctx.db
    .select()
    .from(schema.accessRequest)
    .where(isNotNull(schema.accessRequest.idBlobKey));
  const due = held.filter((r) => {
    if (!r.confirmedAt) return r.createdAt < ago(UNCONFIRMED_ID_DAYS);
    if (r.status === 'pending' || !r.decidedAt) return false;
    if (r.status === 'approved' && hasRecord.has(r.id)) return fetchedLongAgo.has(r.id);
    return r.decidedAt < ago(ID_KEEP_DAYS);
  });
  for (const r of due) {
    if (r.idBlobKey) await ctx.blobs.remove(r.idBlobKey);
    await ctx.db
      .update(schema.accessRequest)
      .set({ idBlobKey: null, idDekWrapped: null, idRemovedAt: now })
      .where(eq(schema.accessRequest.id, r.id));
  }
  return due.length;
}

// ---- The approval record (a PDF for the client's Permanent folder)

const PAGE: [number, number] = [612, 792];
const MARGIN = 54;

function lines(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (line && font.widthOfTextAtSize(next, size) > width) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Only what the standard PDF font can draw (it has no glyphs beyond Latin-1). */
const latin1 = (s: string): string => s.replace(/[^\x20-\x7e\xa0-\xff]/g, '?');

const fmt = (d: Date | null | undefined): string =>
  d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '-';

export interface RecordFacts {
  firmName: string;
  request: Request;
  clientNames: string[];
  approvedBy: string;
  approvedAt: Date;
  roleLabel: string;
}

/** The request, its decision and its photo ID, as a PDF. */
export async function requestRecordPdf(
  facts: RecordFacts,
  id: { bytes: Buffer; contentType: string } | null,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(latin1(`Portal access request - ${facts.request.name}`));
  pdf.setProducer('Vibe Portal');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page: PDFPage = pdf.addPage(PAGE);
  let y = PAGE[1] - MARGIN;
  const width = PAGE[0] - 2 * MARGIN;
  const write = (text: string, size = 11, f = font): void => {
    for (const l of lines(latin1(text), f, size, width)) {
      if (y < MARGIN + size) {
        page = pdf.addPage(PAGE);
        y = PAGE[1] - MARGIN;
      }
      page.drawText(l, { x: MARGIN, y, size, font: f, color: rgb(0, 0, 0) });
      y -= size * 1.45;
    }
  };
  const r = facts.request;
  write(`${facts.firmName}: client portal access request`, 16, bold);
  y -= 6;
  const rows: [string, string][] = [
    ['Name', r.name],
    ['Email given', r.email ?? '-'],
    ['Mobile number given', r.phone ?? '-'],
    ['Confirmed by a code sent to', r.confirmedContact ?? '-'],
    ['Asked for the files of', r.clientAs],
    ['Note', r.note || '-'],
    ['Requested', fmt(r.createdAt)],
    ['Confirmed', fmt(r.confirmedAt)],
    ['Approved', `${fmt(facts.approvedAt)} by ${facts.approvedBy}`],
    ['Access given to', facts.clientNames.join(', ')],
    ...(facts.roleLabel ? ([['Role', facts.roleLabel]] as [string, string][]) : []),
  ];
  for (const [k, v] of rows) {
    write(k, 9, bold);
    write(v);
    y -= 2;
  }
  y -= 8;
  write('Photo ID', 12, bold);
  if (!id) {
    write('No photo ID was sent with this request.');
  } else if (id.contentType === 'application/pdf') {
    write('The photo ID was sent as a PDF: its pages follow.');
    try {
      const src = await PDFDocument.load(id.bytes, { ignoreEncryption: true });
      for (const p of await pdf.copyPages(src, src.getPageIndices())) pdf.addPage(p);
    } catch {
      write('(The PDF could not be read.)');
    }
  } else {
    const img =
      id.contentType === 'image/png' ? await pdf.embedPng(id.bytes) : await pdf.embedJpg(id.bytes);
    const room = y - MARGIN;
    if (room < 200) {
      page = pdf.addPage(PAGE);
      y = PAGE[1] - MARGIN;
    }
    const scale = Math.min(width / img.width, (y - MARGIN) / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x: MARGIN, y: y - h, width: w, height: h });
  }
  return Buffer.from(await pdf.save());
}

/**
 * After an approval: the request's record, as a PDF, for Vibe Files' Portal inbox with the first
 * client's uploads. A failure is logged (the Log shows it); the approval stands.
 */
export async function fileRequestRecord(
  ctx: Ctx,
  o: {
    requestId: string;
    identityId: string;
    clientIds: string[];
    approvedBy: string;
    roleLabel: string;
    firmName: string;
  },
): Promise<void> {
  try {
    const [request] = await ctx.db
      .select()
      .from(schema.accessRequest)
      .where(eq(schema.accessRequest.id, o.requestId));
    if (!request || !o.clientIds[0]) return;
    const names: string[] = [];
    for (const id of o.clientIds) {
      const [c] = await ctx.db
        .select({ name: schema.clients.displayName })
        .from(schema.clients)
        .where(eq(schema.clients.id, id));
      names.push(c?.name ?? id);
    }
    const pdf = await requestRecordPdf(
      {
        firmName: o.firmName,
        request,
        clientNames: names,
        approvedBy: o.approvedBy,
        approvedAt: request.decidedAt ?? ctx.now(),
        roleLabel: o.roleLabel,
      },
      await readIdPhoto(ctx, request),
    );
    const dek = generateKey();
    const stored = await ctx.blobs.put(Readable.from([pdf]), dek, Number.MAX_SAFE_INTEGER);
    const safe =
      request.name
        .replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ')
        .trim()
        .slice(0, 80) || 'person';
    await ctx.db.insert(schema.uploads).values({
      clientId: o.clientIds[0],
      identityId: o.identityId,
      name: `Access request - ${safe}.pdf`,
      contentType: 'application/pdf',
      size: stored.size,
      sha256: stored.sha256,
      blobKey: stored.blobKey,
      dekWrapped: Buffer.from(ctx.keyring.wrap(dek)),
      note: `Access request and photo ID, approved by ${o.approvedBy}`,
      uploadedAt: ctx.now(),
      accessRequestId: request.id,
    });
  } catch (err) {
    ctx.log.error({ err }, 'access request record could not be made');
  }
}
