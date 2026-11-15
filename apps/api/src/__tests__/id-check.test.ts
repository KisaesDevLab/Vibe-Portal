// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Addendum 01 (P80-P88): the firm's choice of what a request for access must carry and whether
// staff must say how they checked; the front and back of an ID with the back's barcode read
// (layer A); the check kept with an approval (layer B).

import { readFileSync } from 'node:fs';

import { schema } from '@vibe-portal/db';
import { eq } from 'drizzle-orm';
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readBarcodeOffThread, readInTurn } from '../files/barcode';
import { aamvaDate, nameDiffers, parseAamva, scanFlags } from '../portal/aamva';
import { purgeIdPhotos } from '../portal/access-id';
import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, ID_PNG, OTHER, sendId, world, type World } from './harness';

/** A made-up licence barcode (the AAMVA standard's layout; nobody's data). */
const LICENCE_NUMBER = 'D1234567';
const AAMVA = [
  '@\n\x1e\rANSI 636014080002DL00410278ZC03190024DLDAQ' + LICENCE_NUMBER,
  'DCSSAMPLE',
  'DDEN',
  'DACALEXANDER',
  'DDFN',
  'DADJAMES',
  'DDGN',
  'DCAC',
  'DBD08242022',
  'DBB01061990',
  'DBA01062027',
  'DBC1',
  'DAG2570 24TH STREET',
  'DAISACRAMENTO',
  'DAJCA',
  'DAK958180000  ',
  'DCGUSA',
  'DCK22236D12345670401\rZCZCABRN',
  'ZCBBRN\n\r',
].join('\n');

const ALEX = 'alex@example.test';
const DAY = 24 * 60;

/** What the stand-in reader answers for the next back picture. */
let barcode: string | null;
let w: World;
beforeEach(async () => {
  barcode = AAMVA;
  w = await world({ readBarcode: async () => barcode });
});
afterEach(async () => {
  await w.close();
});

type Agent = ReturnType<typeof request.agent>;

async function admin(): Promise<Agent> {
  const link = await createSetupLink(w.ctx, null, 'appliance');
  const token = /#t=([\w-]+)/.exec(link)?.[1] ?? '';
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({
      token,
      email: 'kurt@example-cpa.test',
      name: 'Kurt',
      password: 'a long staff password',
    })
    .expect(200);
  await agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
    .expect(200);
  return agent;
}

async function setFirm(v: {
  requestIdMode?: 'none' | 'photo' | 'scan';
  requestCheck?: 'off' | 'required';
}): Promise<void> {
  await w.t.db.update(schema.firm).set(v);
}

async function ask(name = 'Alexander Sample'): Promise<string> {
  const made = await request(w.app)
    .post('/api/portal/access-requests')
    .send({ name, email: ALEX, clientAs: 'Smith, John' })
    .expect(201);
  return made.body.requestId as string;
}

const sendBack = (id: string, bytes: Buffer = ID_PNG): request.Test =>
  request(w.app)
    .post(`/api/portal/access-requests/${id}/id-photo?side=back`)
    .set('Content-Type', 'application/octet-stream')
    .send(bytes);

const confirm = (id: string, more: object = {}): request.Test =>
  request(w.app)
    .post(`/api/portal/access-requests/${id}/confirm`)
    .send({ code: w.code(ALEX), ...more });

async function listed(): Promise<Record<string, unknown>> {
  const list = await w.firm('get', '/access-requests').expect(200);
  return list.body.requests[0] as Record<string, unknown>;
}

function bytes(res: request.Response, done: (err: Error | null, body: unknown) => void): void {
  const parts: Buffer[] = [];
  res.on('data', (c: Buffer) => parts.push(c));
  res.on('end', () => done(null, Buffer.concat(parts)));
}

describe('the firm chooses what a request carries (P88)', () => {
  it('starts as one photo ID and no check, and only an admin changes it', async () => {
    const boss = await admin();
    const s = await boss.get('/api/staff/v1/settings').expect(200);
    expect([s.body.requestIdMode, s.body.requestCheck]).toEqual(['photo', 'off']);
    const page = await request(w.app).get('/api/portal/branding').expect(200);
    expect(page.body.requestIdMode).toBe('photo');
    const list = await w.firm('get', '/access-requests').expect(200);
    expect(list.body.requestCheck).toBe('off');

    const body = {
      firmName: s.body.firmName,
      accentColor: s.body.accentColor,
      uploadLimitMb: s.body.uploadLimitMb,
      uploadKeepDays: s.body.uploadKeepDays,
    };
    // Left out: unchanged (an older page).
    await boss.put('/api/staff/v1/settings').send(body).expect(200);
    await boss
      .put('/api/staff/v1/settings')
      .send({ ...body, requestIdMode: 'scan', requestCheck: 'required' })
      .expect(200);
    await boss.put('/api/staff/v1/settings').send(body).expect(200);
    expect((await request(w.app).get('/api/portal/branding')).body.requestIdMode).toBe('scan');
    expect((await w.firm('get', '/access-requests')).body.requestCheck).toBe('required');
    await boss
      .put('/api/staff/v1/settings')
      .send({ ...body, requestIdMode: 'passport' })
      .expect(400);
  });

  it('no ID: the request confirms without one, and its record is still filed', async () => {
    await setFirm({ requestIdMode: 'none' });
    const id = await ask();
    // A picture sent all the same is refused, and nothing is stored.
    for (const side of ['front', 'back']) {
      const sent = await request(w.app)
        .post(`/api/portal/access-requests/${id}/id-photo?side=${side}`)
        .set('Content-Type', 'application/octet-stream')
        .send(ID_PNG);
      expect([sent.status, sent.body.error]).toEqual([400, 'id_not_asked']);
    }
    const [bare] = await w.t.db.select().from(schema.accessRequest);
    expect([bare?.idBlobKey, bare?.idBackBlobKey]).toEqual([null, null]);
    await confirm(id).expect(200);
    expect((await listed())['idPhoto']).toBeNull();
    const ok = await w
      .firm('post', `/access-requests/${id}/approve`)
      .send({ clientId: CLIENT })
      .expect(200);
    expect(ok.body.recorded).toBe(true);
    const ups = await w.firm('get', '/uploads').expect(200);
    expect(ups.body.uploads).toHaveLength(1);

    // A record that could not be made is made again by the hourly run, with no ID to go by.
    // (Here the first record is cut loose from the request, as if it had never been made.)
    await w.t.db.update(schema.uploads).set({ accessRequestId: null });
    await purgeIdPhotos(w.ctx);
    const mine = () =>
      w.t.db.select().from(schema.uploads).where(eq(schema.uploads.accessRequestId, id));
    expect(await mine()).toHaveLength(1);

    // Never filed by Vibe Files: the portal's copy goes 90 days after approval, and is not
    // made again after that.
    w.later(89 * DAY);
    await purgeIdPhotos(w.ctx);
    expect((await mine())[0]?.blobKey).not.toBeNull();
    w.later(2 * DAY);
    await purgeIdPhotos(w.ctx);
    const gone = await mine();
    expect(gone).toHaveLength(1);
    expect([gone[0]?.blobKey, gone[0]?.purgedAt === null]).toEqual([null, false]);
  });

  it('one photo ID, as before: a back is not asked for', async () => {
    const id = await ask();
    expect((await confirm(id)).body.error).toBe('id_required');
    await sendId(w, id);
    // A back nobody asked for is not kept.
    const back = await sendBack(id);
    expect([back.status, back.body.error]).toEqual([400, 'id_not_asked']);
    await confirm(id).expect(200);
    const r = await listed();
    expect([r['idBack'], r['idScan'], r['idFlags']]).toEqual([null, null, []]);
  });
});

describe('front and back, barcode read (layer A)', () => {
  beforeEach(async () => {
    await setFirm({ requestIdMode: 'scan' });
  });

  it('needs the front and the back; the back is a picture; staff see what it said', async () => {
    const id = await ask();
    expect((await confirm(id)).body.error).toBe('id_required');
    await sendId(w, id);
    expect((await confirm(id)).body.error).toBe('id_back_required');
    const pdf = await sendBack(id, Buffer.from('%PDF-1.4\n%%EOF'));
    expect([pdf.status, pdf.body.error]).toEqual([415, 'id_type']);
    const bad = await request(w.app)
      .post(`/api/portal/access-requests/${id}/id-photo?side=left`)
      .set('Content-Type', 'application/octet-stream')
      .send(ID_PNG);
    expect(bad.status).toBe(400);
    const sent = await sendBack(id).expect(201);
    expect(sent.body.readable).toBe(true);
    await confirm(id).expect(200);

    const r = await listed();
    expect(r['idBack']).toEqual({ contentType: 'image/png', size: ID_PNG.length });
    expect(r['idScan']).toEqual({
      familyName: 'SAMPLE',
      firstName: 'ALEXANDER',
      middleName: 'JAMES',
      dob: '1990-01-06',
      expires: '2027-01-06',
      issued: '2022-08-24',
      address: { street: '2570 24TH STREET', city: 'SACRAMENTO', state: 'CA', zip: '95818' },
      issuer: 'CA, USA',
    });
    expect(r['idFlags']).toEqual([]);
    const back = await w
      .firm('get', `/access-requests/${id}/id-photo?side=back`)
      .buffer(true)
      .parse(bytes)
      .expect(200);
    expect(Buffer.compare(back.body as Buffer, ID_PNG)).toBe(0);
  });

  it('the licence number is in no table, event or log line (P81)', async () => {
    const logged: string[] = [];
    const log = w.ctx.log;
    for (const level of ['info', 'warn', 'error'] as const) {
      const was = log[level].bind(log);
      (log as unknown as Record<string, unknown>)[level] = (...args: unknown[]) => {
        logged.push(JSON.stringify(args));
        return (was as (...a: unknown[]) => void)(...args);
      };
    }
    const id = await ask();
    await sendId(w, id);
    await sendBack(id).expect(201);
    await confirm(id).expect(200);
    await w.firm('post', `/access-requests/${id}/approve`).send({ clientId: CLIENT }).expect(200);
    const everything = JSON.stringify([
      await w.t.db.select().from(schema.accessRequest),
      await w.t.db.select().from(schema.events),
      await w.t.db.select().from(schema.problemLog),
      (await w.firm('get', '/access-requests')).body,
      logged,
    ]);
    expect(everything).toContain('SAMPLE');
    expect(everything).not.toContain(LICENCE_NUMBER);
  });

  it('flags an expired ID and a different name', async () => {
    // 90 days on, the made-up ID (to 6 January 2027) has expired.
    w.later(90 * DAY);
    const id = await ask('Mary Smith');
    await sendId(w, id);
    await sendBack(id).expect(201);
    await confirm(id).expect(200);
    expect((await listed())['idFlags']).toEqual(['expired', 'name_differs']);
  });

  it('a back with no readable barcode is asked for again by the page, then kept and flagged', async () => {
    barcode = null;
    const id = await ask();
    await sendId(w, id);
    expect((await sendBack(id).expect(201)).body.readable).toBe(false);
    // Text that is not a licence barcode is not read either.
    barcode = 'https://example.test/not-a-licence';
    expect((await sendBack(id).expect(201)).body.readable).toBe(false);
    await confirm(id).expect(200);
    const r = await listed();
    expect([r['idScan'], r['idFlags']]).toEqual([null, ['unreadable']]);
  });

  it('an ID with no barcode goes front only, and says so', async () => {
    const id = await ask();
    await sendId(w, id);
    await confirm(id, { noBarcode: true }).expect(200);
    const r = await listed();
    expect([r['idBack'], r['idFlags']]).toEqual([null, ['no_barcode']]);
  });

  it('the approval PDF has the back, the fields and the flags; all go with the front', async () => {
    const id = await ask('Mary Smith');
    await sendId(w, id);
    await sendBack(id).expect(201);
    await confirm(id).expect(200);
    await w.firm('post', `/access-requests/${id}/approve`).send({ clientId: CLIENT }).expect(200);
    const ups = await w.firm('get', '/uploads').expect(200);
    const pdf = await w
      .firm('get', `/uploads/${ups.body.uploads[0].uploadId}/content`)
      .buffer(true)
      .parse(bytes)
      .expect(200);
    const doc = await PDFDocument.load(pdf.body as Buffer);
    // Both sides are attached as sent.
    const attached = doc.context
      .enumerateIndirectObjects()
      .map(([, o]) => (o instanceof PDFDict ? o.get(PDFName.of('UF')) : undefined))
      .filter(
        (n): n is PDFString | PDFHexString => n instanceof PDFString || n instanceof PDFHexString,
      )
      .map((n) => n.decodeText())
      .sort();
    expect(attached).toEqual(['photo-id-back.png', 'photo-id.png']);

    // Denied or approved, the back and what it said go when the front does.
    const other = await ask();
    await sendId(w, other);
    await sendBack(other).expect(201);
    await confirm(other).expect(200);
    await w.firm('post', `/access-requests/${other}/deny`).expect(200);
    w.later(31 * DAY);
    await purgeIdPhotos(w.ctx);
    const [row] = await w.t.db
      .select()
      .from(schema.accessRequest)
      .where(eq(schema.accessRequest.id, other));
    expect([row?.idBlobKey, row?.idBackBlobKey, row?.idScan, row?.idFlags]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(row?.idRemovedAt).not.toBeNull();
    await w.firm('get', `/access-requests/${other}/id-photo?side=back`).expect(404);
  });
});

describe('the firm changes what it asks for while a request is being made', () => {
  it('lowered to one picture: the back and what it said are not kept', async () => {
    await setFirm({ requestIdMode: 'scan' });
    const id = await ask();
    await sendId(w, id);
    await sendBack(id).expect(201);
    await setFirm({ requestIdMode: 'photo' });
    await confirm(id).expect(200);
    const r = await listed();
    expect(r['idPhoto']).not.toBeNull();
    expect([r['idBack'], r['idScan'], r['idFlags']]).toEqual([null, null, []]);
    await w.firm('get', `/access-requests/${id}/id-photo?side=back`).expect(404);
    await w.firm('get', `/access-requests/${id}/id-photo`).expect(200);
  });

  it('lowered to none: neither picture is kept', async () => {
    await setFirm({ requestIdMode: 'scan' });
    const id = await ask();
    await sendId(w, id);
    await sendBack(id).expect(201);
    await setFirm({ requestIdMode: 'none' });
    await confirm(id).expect(200);
    const r = await listed();
    expect([r['idPhoto'], r['idBack'], r['idScan'], r['idFlags']]).toEqual([null, null, null, []]);
    const [row] = await w.t.db.select().from(schema.accessRequest);
    expect([row?.idBlobKey, row?.idBackBlobKey]).toEqual([null, null]);
    await w.firm('get', `/access-requests/${id}/id-photo`).expect(404);
  });

  it('raised: the front, then the back, are asked for at the code', async () => {
    await setFirm({ requestIdMode: 'none' });
    const id = await ask();
    await setFirm({ requestIdMode: 'scan' });
    expect((await confirm(id)).body.error).toBe('id_required');
    await sendId(w, id);
    expect((await confirm(id)).body.error).toBe('id_back_required');
    await confirm(id, { noBarcode: true }).expect(200);
    expect((await listed())['idFlags']).toEqual(['no_barcode']);
  });
});

describe('check before approving (layer B)', () => {
  async function waiting(): Promise<string> {
    const id = await ask();
    await sendId(w, id);
    await confirm(id).expect(200);
    return id;
  }
  const approve = (id: string, body: object): request.Test =>
    w.firm('post', `/access-requests/${id}/approve`).send({ clientId: CLIENT, ...body });

  it('off: an approval with no check works, as an older Vibe Files sends it', async () => {
    const id = await waiting();
    await approve(id, {}).expect(200);
  });

  it('required: refused without a check; a match from Vibe Files is kept and printed', async () => {
    await setFirm({ requestCheck: 'required' });
    const id = await waiting();
    const none = await approve(id, {});
    expect([none.status, none.body.error]).toEqual([400, 'check_required']);
    // A match must say what matched; nothing has passed a vendor's check.
    expect((await approve(id, { check: { method: 'record_match' } })).body.error).toBe(
      'check_invalid',
    );
    expect((await approve(id, { check: { method: 'vendor' } })).body.error).toBe('check_invalid');
    expect((await approve(id, { check: { method: 'callback' } })).body.error).toBe(
      'check_note_required',
    );
    // Still waiting: nothing above approved it.
    expect((await w.firm('get', '/access-requests')).body.requests).toHaveLength(1);

    await approve(id, { check: { method: 'record_match', matched: ['email', 'dob'] } }).expect(200);
    const [row] = await w.t.db
      .select()
      .from(schema.accessRequest)
      .where(eq(schema.accessRequest.id, id));
    expect([row?.checkMethod, row?.checkMatched]).toEqual(['record_match', ['email', 'dob']]);
    const events = await w.t.db
      .select()
      .from(schema.events)
      .where(eq(schema.events.kind, 'approve'));
    expect((events[0]?.detail as { check?: unknown }).check).toEqual({
      method: 'record_match',
      matched: ['email', 'dob'],
      note: '',
    });
  });

  it('the staff page says how it checked, and cannot claim a match to the client record', async () => {
    await setFirm({ requestCheck: 'required' });
    const boss = await admin();
    const id = await waiting();
    const go = (check?: object): request.Test =>
      boss
        .post(`/api/staff/v1/access-requests/${id}/approve`)
        .send({ clientIds: [CLIENT, OTHER], roleLabel: '', ...(check ? { check } : {}) });
    expect((await go()).body.error).toBe('check_required');
    expect((await go({ method: 'record_match', matched: ['email'] })).body.error).toBe(
      'check_invalid',
    );
    expect((await go({ method: 'other', note: '  ' })).body.error).toBe('check_note_required');
    await go({ method: 'callback', note: 'Alexander, on his office line' }).expect(200);
    const [row] = await w.t.db
      .select()
      .from(schema.accessRequest)
      .where(eq(schema.accessRequest.id, id));
    expect([row?.checkMethod, row?.checkNote]).toEqual([
      'callback',
      'Alexander, on his office line',
    ]);
    // In the client's History, in words.
    const history = await boss.get(`/api/staff/v1/clients/${CLIENT}/history`).expect(200);
    const approved = (history.body.events as { kind: string; check?: string }[]).find(
      (e) => e.kind === 'approve',
    );
    expect(approved?.check).toBe(
      "Called the number in the firm's records; spoke to Alexander, on his office line",
    );

    // A staff member limited to this client sees the approval in its History, not how it was
    // checked: access requests are for staff who see every client.
    const made = await boss
      .post('/api/staff/v1/staff')
      .send({ email: 'lee@example-cpa.test', name: 'Lee', clientIds: [CLIENT] })
      .expect(201);
    const token = /#t=([\w-]+)/.exec(made.body.setupLink as string)?.[1] ?? '';
    const lee = request.agent(w.app);
    const set = await lee
      .post('/api/staff/auth/setup')
      .send({ token, password: 'another long password' })
      .expect(200);
    await lee
      .post('/api/staff/auth/setup/confirm')
      .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
      .expect(200);
    const seen = await lee.get(`/api/staff/v1/clients/${CLIENT}/history`).expect(200);
    const theirs = (seen.body.events as { kind: string; check?: string | null }[]).find(
      (e) => e.kind === 'approve',
    );
    expect(theirs).toBeTruthy();
    expect(theirs?.check).toBeNull();
  });

  it('met in person needs no note', async () => {
    await setFirm({ requestCheck: 'required' });
    const id = await waiting();
    await approve(id, { check: { method: 'in_person' } }).expect(200);
  });
});

describe('the barcode itself', () => {
  it('reads a licence barcode from a picture, in a process of its own', async () => {
    const png = readFileSync(new URL('./fixtures/aamva-back.png', import.meta.url));
    const text = await readBarcodeOffThread(png, 'png');
    const scan = parseAamva(text ?? '');
    expect([scan?.familyName, scan?.firstName, scan?.dob, scan?.address.zip]).toEqual([
      'SAMPLE',
      'ALEXANDER',
      '1990-01-06',
      '95818',
    ]);
    expect(JSON.stringify(scan)).not.toContain(LICENCE_NUMBER);
    // A picture with no barcode: nothing, not an error.
    expect(await readBarcodeOffThread(ID_PNG, 'png')).toBeNull();
    // The reader's process is given none of the server's settings.
    const worker = readFileSync(new URL('../files/barcode.ts', import.meta.url), 'utf8');
    expect(worker).toContain('env: READER_ENV');
  }, 60_000);

  it('a picture is read in its turn, or kept unread when the turn does not come in time', async () => {
    const order: string[] = [];
    let free!: () => void;
    const held = new Promise<void>((r) => (free = r));
    const first = readInTurn(async () => {
      order.push('first starts');
      await held;
      order.push('first ends');
      return 'one';
    });
    // Waits its turn: starts only once the first has ended.
    const second = readInTurn(async () => {
      order.push('second starts');
      return 'two';
    });
    // Gives up after 20 ms: answered null, and never read.
    const third = readInTurn(async () => {
      order.push('third starts');
      return 'three';
    }, 20);
    expect(await third).toBeNull();
    free();
    expect([await first, await second]).toEqual(['one', 'two']);
    expect(order).toEqual(['first starts', 'first ends', 'second starts']);
    // The line moves on past the one that gave up.
    expect(await readInTurn(async () => 'four')).toBe('four');
  });

  it('parses US and Canadian dates, older name layouts, and nothing else', () => {
    expect(aamvaDate('01061990', false)).toBe('1990-01-06');
    expect(aamvaDate('19900106', true)).toBe('1990-01-06');
    // Reads only one way: the year cannot be 0106.
    expect(aamvaDate('19901231', false)).toBe('1990-12-31');
    expect(aamvaDate('13451990', false)).toBeNull();
    expect(aamvaDate('', false)).toBeNull();
    const old = parseAamva(
      '@\n\x1e\rANSI 6360000102DL00390188DLDAASMITH,MARY,ANN\nDAQ12345\nDBB19800229\nDBA20301231\nDAJVA\r',
    );
    expect([old?.familyName, old?.firstName, old?.middleName, old?.dob, old?.expires]).toEqual([
      'SMITH',
      'MARY',
      'ANN',
      '1980-02-29',
      '2030-12-31',
    ]);
    const canada = parseAamva(
      '@\n\x1e\rANSI 636012090001DL00310200DLDCSTREMBLAY\nDACJEAN-LUC\nDBB19751130\nDBA20280704\nDAJON\nDAKK1A 0B1\nDCGCAN\r',
    );
    expect([canada?.dob, canada?.expires, canada?.address.zip, canada?.issuer]).toEqual([
      '1975-11-30',
      '2028-07-04',
      'K1A 0B1',
      'ON, CAN',
    ]);
    expect(parseAamva('https://example.test')).toBeNull();
    expect(parseAamva('@\n\x1e\rANSI 636014080002DL00410278DLDAQD1234567\r')).toBeNull();
  });

  it('compares names without case, accents, punctuation or middle names', () => {
    const scan = parseAamva(AAMVA);
    if (!scan) throw new Error('not parsed');
    expect(nameDiffers('alexander sample', scan)).toBe(false);
    expect(nameDiffers('Sample, Alexander J.', scan)).toBe(false);
    expect(nameDiffers('Alex Sample', scan)).toBe(true);
    expect(nameDiffers('Alexander Smith', scan)).toBe(true);
    const accented = { ...scan, familyName: 'DE LA PEÑA', firstName: 'JOSÉ MARÍA' };
    expect(nameDiffers('Jose de la Pena', accented)).toBe(false);
    expect(scanFlags(null, 'Anyone', new Date())).toEqual(['unreadable']);
    expect(scanFlags(scan, 'Alexander Sample', new Date('2027-01-06T12:00:00'))).toEqual([]);
    expect(scanFlags(scan, 'Alexander Sample', new Date('2027-01-07T12:00:00'))).toEqual([
      'expired',
    ]);
  });
});
