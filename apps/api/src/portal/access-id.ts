// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P67: the photo ID sent with an access request (a driver's license, state ID or passport).
//
// - Stored encrypted with the firm key, like an upload (and in B2 when files are there).
// - Shown to the staff who decide requests (those who see every client).
// - On approval, a PDF of the request and its photo ID goes to Vibe Files' Portal inbox as an
//   upload of the first client, named "Access request - <name> - <date time>.pdf" (Vibe Files
//   puts the client's name and code in front). One per request (a unique index). The client never sees it among their uploads, nor do
//   staff limited to some clients.
// - Deleted 7 days after Vibe Files fetched the record (it fetches only once the checksum
//   matches), the portal's copy of the PDF too; a denied request's 30 days after the decision;
//   an unconfirmed request's a day after it was made.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { generateKey } from '@vibe/crypto';
import fontkit from '@pdf-lib/fontkit';
import { degrees, PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { schema } from '@vibe-portal/db';

import { firmName, type Ctx } from '../context';
import { convertHeicQueued, HEIC_MAX_BYTES } from '../files/heic';
import { kindOf, SNIFF_BYTES } from '../files/sniff';
import { record } from '../lib/events';
import { HttpError } from '../lib/http';

/** A phone photo or a scan: plenty for an ID, small enough to hold while checking it. */
export const ID_MAX_BYTES = 15 * 1024 * 1024;
/** A picture larger than this is refused: a small PNG can declare an enormous image, and a PNG
 *  is decoded whole to go in the PDF (a JPEG is copied as it is). A phone photo is 12-50 MP. */
export const ID_MAX_PIXELS = { jpeg: 60_000_000, png: 25_000_000 } as const;
export const ID_MAX_SIDE = 12_000;
/** Days a denied request's ID is kept (owner 2026-11-11). */
export const ID_KEEP_DAYS = 30;
/** The code of a request lasts 15 minutes; its ID is not kept past a day unconfirmed. */
const UNCONFIRMED_ID_DAYS = 1;
const DAY = 24 * 3_600_000;

type Request = typeof schema.accessRequest.$inferSelect;
const TYPES = { jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' } as const;

/**
 * The EXIF orientation of a JPEG (1 upright, 3 upside down, 6 turned a quarter clockwise to
 * show, 8 a quarter counter-clockwise), or 1 when it says nothing. Mirrored ones count as 1.
 */
export function jpegOrientation(b: Buffer): number {
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const m = b[i + 1] as number;
    const len = b.readUInt16BE(i + 2);
    if (m === 0xe1 && b.subarray(i + 4, i + 10).toString('latin1') === 'Exif\0\0') {
      const t = i + 10;
      const le = b.subarray(t, t + 2).toString('latin1') === 'II';
      const u16 = (o: number): number => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
      const u32 = (o: number): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
      const ifd = t + u32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > b.length) return 1;
        if (u16(e) === 0x0112) {
          const v = u16(e + 8);
          return v === 3 || v === 6 || v === 8 ? v : 1;
        }
      }
      return 1;
    }
    if (m === 0xda) return 1;
    i += 2 + len;
  }
  return 1;
}

/** Width and height a PNG or JPEG declares, or null when it declares none. */
export function imageSize(b: Buffer, kind: 'png' | 'jpeg'): { w: number; h: number } | null {
  if (kind === 'png') {
    if (b.length < 24 || b.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  // JPEG: walk the markers to a start-of-frame (SOF0-SOF15, not DHT/JPG/DAC).
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1] as number;
    if (m === 0xff) {
      i += 1;
      continue;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    if (m === 0xda || m === 0xd9) return null;
    i += 2 + len;
  }
  return null;
}

/** Refuses a picture that is not one, or too large to put in the PDF. */
function checkPicture(b: Buffer, kind: 'png' | 'jpeg'): void {
  const size = imageSize(b, kind);
  if (!size || size.w === 0 || size.h === 0) throw new HttpError(415, 'photo_unreadable');
  if (size.w > ID_MAX_SIDE || size.h > ID_MAX_SIDE || size.w * size.h > ID_MAX_PIXELS[kind]) {
    throw new HttpError(413, 'image_too_large');
  }
}

/**
 * Stores the photo ID for a request still waiting for its code, replacing one sent before.
 * JPEG, PNG or PDF, by content; a phone's HEIC photo is converted to JPEG. Refused (and nothing
 * kept) when the request was confirmed or decided while it was being sent.
 */
export async function storeIdPhoto(
  ctx: Ctx,
  requestId: string,
  body: Readable,
  convertHeic: (b: Buffer) => Promise<Buffer> = convertHeicQueued,
): Promise<{ contentType: string; size: number }> {
  // Held in memory (at most 15 MB): a picture is checked whole before it is kept.
  const parts: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    size += (c as Buffer).length;
    if (size > Math.min(ID_MAX_BYTES, HEIC_MAX_BYTES)) throw new HttpError(413, 'too_large');
    parts.push(c as Buffer);
  }
  let bytes: Buffer = Buffer.concat(parts);
  const kind = kindOf(bytes.subarray(0, SNIFF_BYTES));
  if (kind !== 'jpeg' && kind !== 'png' && kind !== 'pdf' && kind !== 'heic') {
    throw new HttpError(415, 'id_type');
  }
  let contentType: string;
  if (kind === 'heic') {
    try {
      bytes = await convertHeic(bytes);
    } catch (err) {
      ctx.log.warn({ err }, 'photo ID: heic conversion failed');
      throw new HttpError(415, 'photo_unreadable');
    }
    checkPicture(bytes, 'jpeg');
    contentType = TYPES.jpeg;
  } else {
    if (kind !== 'pdf') checkPicture(bytes, kind);
    contentType = TYPES[kind];
  }
  const dek = generateKey();
  const stored = await ctx.blobs.put(Readable.from([bytes]), dek, ID_MAX_BYTES);
  // Only while the request still waits for its code; the earlier ID is read in the same step.
  const old = await ctx.db.transaction(async (tx) => {
    const [cur] = await tx
      .select({ key: schema.accessRequest.idBlobKey })
      .from(schema.accessRequest)
      .where(
        and(
          eq(schema.accessRequest.id, requestId),
          eq(schema.accessRequest.status, 'pending'),
          isNull(schema.accessRequest.confirmedAt),
        ),
      )
      .for('update');
    if (!cur) return undefined;
    await tx
      .update(schema.accessRequest)
      .set({
        idBlobKey: stored.blobKey,
        idDekWrapped: Buffer.from(ctx.keyring.wrap(dek)),
        idContentType: contentType,
        idSize: stored.size,
        idRemovedAt: null,
      })
      .where(eq(schema.accessRequest.id, requestId));
    return cur.key;
  });
  if (old === undefined) {
    await ctx.blobs.remove(stored.blobKey);
    throw new HttpError(409, 'request_closed');
  }
  if (old) await ctx.blobs.remove(old);
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
/** Days after approval the photo ID is kept at most, fetched or not (owner 2026-11-11: a firm
 *  that does not fetch for a while does not keep IDs for ever). */
export const APPROVED_MAX_DAYS = 90;

/**
 * Removes photo IDs past their time (run hourly), first making any record an approval could
 * not make:
 * - approved: 7 days after Vibe Files fetched the record PDF; the portal's copy of the PDF goes
 *   too. Kept until then (a record that cannot be made is tried again hourly, and the Log says
 *   why), but never more than 90 days after approval (the Log says so).
 * - denied: 30 days after the decision.
 * - never confirmed: a day after the request.
 */
export async function purgeIdPhotos(ctx: Ctx): Promise<number> {
  await remakeMissingRecords(ctx);
  const now = ctx.now();
  const ago = (days: number): Date => new Date(now.getTime() - days * DAY);
  const records = await ctx.db
    .select({
      requestId: schema.uploads.accessRequestId,
      uploadId: schema.uploads.id,
      clientId: schema.uploads.clientId,
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
      if (done) {
        await ctx.blobs.remove(r.blobKey);
        await record(
          ctx.db,
          'upload_purged',
          { kind: 'system', name: 'purge' },
          // Not in the client's History, as the record's other events.
          { uploadId: r.uploadId },
        );
      }
    }
  }
  const held = await ctx.db
    .select()
    .from(schema.accessRequest)
    .where(isNotNull(schema.accessRequest.idBlobKey));
  const due = held.filter((r) => {
    if (!r.confirmedAt) return r.createdAt < ago(UNCONFIRMED_ID_DAYS);
    if (r.status === 'pending' || !r.decidedAt) return false;
    // Approved: kept until the firm has the record (made again hourly until then), and never
    // more than 90 days.
    if (r.status === 'approved') {
      return (
        (hasRecord.has(r.id) && fetchedLongAgo.has(r.id)) || r.decidedAt < ago(APPROVED_MAX_DAYS)
      );
    }
    return r.decidedAt < ago(ID_KEEP_DAYS);
  });
  for (const r of due) {
    if (r.status === 'approved' && !fetchedLongAgo.has(r.id)) {
      // Past the cap without Vibe Files fetching it: the portal's copy of the record goes too.
      ctx.log.warn(
        { accessRequestId: r.id, days: APPROVED_MAX_DAYS },
        'photo ID deleted after 90 days: Vibe Files never fetched the request PDF',
      );
      for (const rec of records.filter((x) => x.requestId === r.id && x.blobKey)) {
        const [done] = await ctx.db
          .update(schema.uploads)
          .set({ purgedAt: now, blobKey: null, dekWrapped: null })
          .where(and(eq(schema.uploads.id, rec.uploadId), isNull(schema.uploads.purgedAt)))
          .returning({ id: schema.uploads.id });
        if (done && rec.blobKey) await ctx.blobs.remove(rec.blobKey);
      }
    }
    if (r.idBlobKey) await ctx.blobs.remove(r.idBlobKey);
    await ctx.db
      .update(schema.accessRequest)
      .set({ idBlobKey: null, idDekWrapped: null, idRemovedAt: now })
      .where(eq(schema.accessRequest.id, r.id));
  }
  return due.length;
}

/** An approved request whose record could not be made (it still has its ID): made again, from
 *  what the approval stored (the person, every client, the role). */
async function remakeMissingRecords(ctx: Ctx): Promise<void> {
  const rows = await ctx.db
    .select({ r: schema.accessRequest, upload: schema.uploads.id })
    .from(schema.accessRequest)
    .leftJoin(schema.uploads, eq(schema.uploads.accessRequestId, schema.accessRequest.id))
    .where(
      and(
        eq(schema.accessRequest.status, 'approved'),
        isNotNull(schema.accessRequest.idBlobKey),
        isNotNull(schema.accessRequest.identityId),
      ),
    );
  const missing = rows.filter(({ upload }) => !upload);
  if (missing.length === 0) return;
  const firm = await firmName(ctx);
  for (const { r } of missing) {
    const clientIds = r.clientIds ?? (r.clientId ? [r.clientId] : []);
    if (!r.identityId || clientIds.length === 0) continue;
    await fileRequestRecord(ctx, {
      requestId: r.id,
      identityId: r.identityId,
      clientIds,
      approvedBy: r.decidedBy ?? '',
      roleLabel: r.roleLabel ?? '',
      firmName: firm,
    });
  }
}

// ---- The approval record (a PDF for Vibe Files' Portal inbox)

const PAGE: [number, number] = [612, 792];
const MARGIN = 54;

/** Lines of at most `width`; a word longer than a line (a link in a note) is cut. */
function lines(text: string, font: PDFFont, size: number, width: number): string[] {
  const fits = (s: string): boolean => font.widthOfTextAtSize(s, size) <= width;
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (let word of para.split(/\s+/)) {
      while (!fits(word)) {
        let n = word.length - 1;
        while (n > 1 && !fits(word.slice(0, n))) n -= 1;
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(word.slice(0, n));
        word = word.slice(n);
      }
      const next = line ? `${line} ${word}` : word;
      if (line && !fits(next)) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** DejaVu Sans, embedded (subset) so names and notes in most alphabets show as written: Latin,
 *  Greek, Cyrillic, Hebrew, Arabic, Armenian, Georgian and more. Chinese, Japanese and Korean are
 *  not in it (a font for them is about 16 MB): those characters show as "?"; the original photo
 *  ID is attached to the PDF either way. */
const FONT_DIR = join(
  dirname(createRequire(import.meta.url).resolve('dejavu-fonts-ttf/package.json')),
  'ttf',
);
let fonts: { regular: Buffer; bold: Buffer } | null = null;
function fontFiles(): { regular: Buffer; bold: Buffer } {
  fonts ??= {
    regular: readFileSync(join(FONT_DIR, 'DejaVuSans.ttf')),
    bold: readFileSync(join(FONT_DIR, 'DejaVuSans-Bold.ttf')),
  };
  return fonts;
}

/** What the font can draw: tabs as spaces, any other character it lacks as "?". */
function drawable(s: string, font: PDFFont): string {
  const has = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of s.replace(/\t/g, ' ')) {
    const code = ch.codePointAt(0) ?? 0;
    out += ch === '\n' || has.has(code) ? ch : '?';
  }
  return out;
}

/** "2026-11-11 1430": the approval's date and time on the appliance's clock, for the file name
 *  (no colon: Windows file names cannot have one). Two people of the same name get two names. */
export function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/** A time in the PDF: the appliance's clock with its zone, as the file name's (e.g. "2026-11-11
 *  14:30 CST"). */
const fmt = (d: Date | null | undefined): string => {
  if (!d) return '-';
  const zone =
    new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  const s = stamp(d);
  return `${s.slice(0, 13)}:${s.slice(13)}${zone ? ` ${zone}` : ''}`;
};

export interface RecordFacts {
  firmName: string;
  request: Request;
  clientNames: string[];
  approvedBy: string;
  approvedAt: Date;
  roleLabel: string;
}

/** The request, its decision and its photo ID, as a PDF; the original ID file is attached. */
export async function requestRecordPdf(
  facts: RecordFacts,
  id: { bytes: Buffer; contentType: string } | null,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Portal access request - ${facts.request.name}`);
  pdf.setProducer('Vibe Portal');
  const files = fontFiles();
  const font = await pdf.embedFont(files.regular, { subset: true });
  const bold = await pdf.embedFont(files.bold, { subset: true });
  let page: PDFPage = pdf.addPage(PAGE);
  let y = PAGE[1] - MARGIN;
  const width = PAGE[0] - 2 * MARGIN;
  const write = (text: string, size = 11, f = font): void => {
    for (const l of lines(drawable(text, f), f, size, width)) {
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
    ['Request id on the portal', r.id],
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
  } else {
    // The file as sent, whatever happens below.
    const ext =
      id.contentType === 'application/pdf' ? 'pdf' : id.contentType === 'image/png' ? 'png' : 'jpg';
    await pdf.attach(id.bytes, `photo-id.${ext}`, {
      mimeType: id.contentType,
      description: 'The photo ID as sent',
    });
    if (id.contentType === 'application/pdf') {
      try {
        const src = await PDFDocument.load(id.bytes, { ignoreEncryption: true });
        if (src.isEncrypted) {
          write('The photo ID is a password-protected PDF: it is attached to this document.');
        } else {
          write('The photo ID was sent as a PDF: its pages follow (it is also attached).');
          for (const p of await pdf.copyPages(src, src.getPageIndices())) pdf.addPage(p);
        }
      } catch {
        write('The photo ID PDF could not be read: it is attached to this document.');
      }
    } else {
      try {
        const img =
          id.contentType === 'image/png'
            ? await pdf.embedPng(id.bytes)
            : await pdf.embedJpg(id.bytes);
        if (y - MARGIN < 200) {
          page = pdf.addPage(PAGE);
          y = PAGE[1] - MARGIN;
        }
        // A phone photo is often stored sideways with a note to turn it (EXIF orientation).
        const turn = id.contentType === 'image/jpeg' ? jpegOrientation(id.bytes) : 1;
        const sideways = turn === 6 || turn === 8;
        const shownW = sideways ? img.height : img.width;
        const shownH = sideways ? img.width : img.height;
        const scale = Math.min(width / shownW, (y - MARGIN) / shownH, 1);
        const w = img.width * scale;
        const h = img.height * scale;
        // pdf-lib turns an image about its lower-left corner, counter-clockwise.
        const at =
          turn === 6
            ? { x: MARGIN, y, rotate: degrees(-90) }
            : turn === 8
              ? { x: MARGIN + h, y: y - w, rotate: degrees(90) }
              : turn === 3
                ? { x: MARGIN + w, y, rotate: degrees(180) }
                : { x: MARGIN, y: y - h, rotate: degrees(0) };
        page.drawImage(img, { ...at, width: w, height: h });
      } catch {
        write('The photo could not be shown here: it is attached to this document.');
      }
    }
  }
  return Buffer.from(await pdf.save());
}

/**
 * After an approval: the request's record, as a PDF, for Vibe Files' Portal inbox with the first
 * client's uploads. False when it could not be made: logged (the Log shows it), and made again
 * by the hourly purge while the photo ID is kept. The approval stands either way.
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
): Promise<boolean> {
  try {
    const [request] = await ctx.db
      .select()
      .from(schema.accessRequest)
      .where(eq(schema.accessRequest.id, o.requestId));
    if (!request || !o.clientIds[0]) return false;
    const found = await ctx.db
      .select({ id: schema.clients.id, name: schema.clients.displayName })
      .from(schema.clients)
      .where(inArray(schema.clients.id, o.clientIds));
    const names = o.clientIds.map((id) => found.find((c) => c.id === id)?.name ?? id);
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
    const [row] = await ctx.db
      .insert(schema.uploads)
      .values({
        clientId: o.clientIds[0],
        identityId: o.identityId,
        name: `Access request - ${safe} - ${stamp(request.decidedAt ?? ctx.now())}.pdf`,
        contentType: 'application/pdf',
        size: stored.size,
        sha256: stored.sha256,
        blobKey: stored.blobKey,
        dekWrapped: Buffer.from(ctx.keyring.wrap(dek)),
        note: `Access request and photo ID, approved by ${o.approvedBy}`,
        uploadedAt: ctx.now(),
        accessRequestId: request.id,
      })
      // One record per request: the approval and the hourly retry may meet.
      .onConflictDoNothing()
      .returning({ id: schema.uploads.id });
    if (!row) {
      await ctx.blobs.remove(stored.blobKey);
      return true;
    }
    await record(
      ctx.db,
      'upload',
      { kind: 'system', name: 'portal' },
      {
        // Not in the client's History (staff limited to the client see that): the person's.
        identityId: o.identityId,
        uploadId: row.id,
        detail: { accessRequestId: request.id, record: true },
      },
    );
    return true;
  } catch (err) {
    ctx.log.error({ err }, 'access request record could not be made');
    return false;
  }
}
