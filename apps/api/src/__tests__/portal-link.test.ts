// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P76: each client's link from another service, set by staff one at a time or from a CSV, and
// shown to the client's people at the top of their portal.

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkLink, parseCsv } from '../firm/client-links';
import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { CLIENT, OTHER, world, type World } from './harness';

const THIRD = '33333333-3333-4333-8333-333333333333';
const PASSWORD = 'a long staff password';
type Agent = ReturnType<typeof request.agent>;

let w: World;
let staff: Agent;
beforeEach(async () => {
  w = await world();
  await w.firm('put', `/clients/${THIRD}`).send({ clientCode: 'ACME', displayName: 'Acme Inc' });
  staff = await finish(await createSetupLink(w.ctx, null, 'appliance'), 'kurt@example-cpa.test');
});
afterEach(async () => {
  await w.close();
});

async function finish(link: string, email?: string): Promise<Agent> {
  const token = /#t=([\w-]+)/.exec(link)?.[1] ?? '';
  const agent = request.agent(w.app);
  const set = await agent
    .post('/api/staff/auth/setup')
    .send({ token, ...(email ? { email, name: 'Kurt' } : {}), password: PASSWORD })
    .expect(200);
  await agent
    .post('/api/staff/auth/setup/confirm')
    .send({ token, code: totpCode(set.body.secret as string, w.ctx.now()) })
    .expect(200);
  return agent;
}

const link = (id: string) => `/api/staff/v1/clients/${id}/link`;

describe('a client link (P76)', () => {
  it('is set, shown to the client, changed and removed', async () => {
    const { agent } = await w.member('mary@example.test');
    expect((await agent.get('/api/portal/client-link').expect(200)).body.link).toBeNull();
    await staff
      .put(link(CLIENT))
      .send({
        url: 'https://pay.example.com/c/8f2a',
        message: 'Your invoice is ready.',
        button: '',
      })
      .expect(200);
    expect((await agent.get('/api/portal/client-link').expect(200)).body.link).toEqual({
      url: 'https://pay.example.com/c/8f2a',
      message: 'Your invoice is ready.',
      button: 'Open',
    });
    await staff
      .put(link(CLIENT))
      .send({ url: 'https://pay.example.com/c/new', message: 'Pay here', button: 'Pay now' })
      .expect(200);
    expect((await staff.get(link(CLIENT)).expect(200)).body.link.button).toBe('Pay now');
    await staff.delete(link(CLIENT)).expect(200);
    expect((await agent.get('/api/portal/client-link').expect(200)).body.link).toBeNull();
    const kinds = (
      await staff.get(`/api/staff/v1/clients/${CLIENT}/history`).expect(200)
    ).body.events.map((e: { kind: string }) => e.kind);
    expect(kinds.filter((k: string) => k.startsWith('client_link'))).toEqual([
      'client_link_removed',
      'client_link_set',
      'client_link_set',
    ]);
  });

  it('is only http or https, with a message', async () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://x.test',
      'no',
      'https://a:b@x.test',
      // URL() takes these as https, but a page reads them as a path on the portal.
      'https:x.test',
      'https:/x.test',
      'https:\\x.test',
      '\u0001https://x.test',
      'https://x.test/\u0000',
    ]) {
      const res = await staff.put(link(CLIENT)).send({ url, message: 'Hi' });
      expect(res.status, url).toBe(400);
      expect(res.body.error).toBe('invalid_url');
    }
    expect(
      (await staff.put(link(CLIENT)).send({ url: 'https://x.test', message: '  ' })).body.error,
    ).toBe('invalid_message');
    expect(checkLink({ url: ' https://x.test/a ', message: ' Pay \n now\u0000 ' })).toEqual({
      url: 'https://x.test/a',
      message: 'Pay now',
      button: 'Open',
    });
    // Stored as the browser will read it.
    expect(checkLink({ url: 'HTTPS://X.test', message: 'Hi' })).toMatchObject({
      url: 'https://x.test/',
    });
  });

  it('a client people cannot see is not theirs; the other client shows nothing', async () => {
    const { agent } = await w.member('mary@example.test', OTHER);
    await staff.put(link(CLIENT)).send({ url: 'https://x.test', message: 'Hi' }).expect(200);
    expect((await agent.get('/api/portal/client-link').expect(200)).body.link).toBeNull();
    await request(w.app).get('/api/portal/client-link').expect(401);
  });

  it('staff limited to some clients reach only theirs', async () => {
    const res = await staff
      .post('/api/staff/v1/staff')
      .send({ email: 'jane@example-cpa.test', name: 'Jane', clientIds: [OTHER] })
      .expect(201);
    const jane = await finish(res.body.setupLink as string);
    await jane.put(link(CLIENT)).send({ url: 'https://x.test', message: 'Hi' }).expect(404);
    await jane.put(link(OTHER)).send({ url: 'https://x.test', message: 'Hi' }).expect(200);
    await staff.put(link(THIRD)).send({ url: 'https://y.test', message: 'Hi' }).expect(200);
    const mine = (await jane.get('/api/staff/v1/client-links').expect(200)).body.links;
    expect(mine.map((l: { clientId: string }) => l.clientId)).toEqual([OTHER]);
    // In a CSV, a client outside the list is not found (not told apart from one not there).
    const r = await jane
      .post('/api/staff/v1/client-links/import')
      .send({ csv: 'client_code,url,message\nACME,https://z.test,Hi\n', apply: true })
      .expect(200);
    expect(r.body.rows[0].status).toBe('not_found');
    expect((await staff.get(link(THIRD))).body.link.url).toBe('https://y.test/');
  });

  it('the firm key cannot set links', async () => {
    await w
      .firm('put', `/clients/${CLIENT}/link`)
      .send({ url: 'https://x.test', message: 'Hi' })
      .expect(404);
  });
});

describe('a CSV of client links (P76)', () => {
  const imp = (csv: string, apply = false) =>
    staff.post('/api/staff/v1/client-links/import').send({ csv, apply }).expect(200);

  it('previews, then applies: code first, then name; overwrite; blank URL removes', async () => {
    await staff.put(link(OTHER)).send({ url: 'https://old.test', message: 'Old' }).expect(200);
    const csv = [
      'Client Code,Client Name,URL,Message,Button',
      'acme,,https://pay.example.com/c/1,"Your invoice, ready.",Pay now',
      '1001,"Smith, John",https://pay.example.com/c/2,Hello,',
      '1001,,https://pay.example.com/c/3,Hello,',
      ',Smith Farms LLC,,,',
      'NOPE,Nobody,https://x.test,Hi,',
      'ACME,,https://pay.example.com/c/9,Again,',
      ',Acme Inc,javascript:alert(1),Hi,',
      '',
    ].join('\r\n');
    const preview = await imp(csv);
    expect(preview.body.applied).toBe(false);
    expect(
      preview.body.rows.map((r: { line: number; status: string }) => [r.line, r.status]),
    ).toEqual([
      [2, 'new'],
      [3, 'new'],
      [4, 'ambiguous'],
      [5, 'removed'],
      [6, 'not_found'],
      [7, 'duplicate'],
      [8, 'duplicate'],
    ]);
    // Nothing changed yet.
    expect((await staff.get(link(THIRD))).body.link).toBeNull();
    expect((await staff.get(link(OTHER))).body.link.url).toBe('https://old.test/');

    const done = await imp(csv, true);
    expect(done.body.changes).toBe(3);
    expect((await staff.get(link(THIRD))).body.link).toEqual({
      url: 'https://pay.example.com/c/1',
      message: 'Your invoice, ready.',
      button: 'Pay now',
    });
    expect((await staff.get(link(CLIENT))).body.link.button).toBe('Open');
    expect((await staff.get(link(OTHER))).body.link).toBeNull();

    // The same file again changes nothing.
    const again = await imp(csv, true);
    expect(again.body.changes).toBe(0);
    expect(again.body.rows[0].status).toBe('unchanged');
    expect(again.body.rows[3].status).toBe('no_link');
  });

  it('a bad URL in a row is reported and the row skipped', async () => {
    const r = await imp('client_code,url,message\nACME,javascript:alert(1),Hi\n', true);
    expect(r.body.rows[0]).toMatchObject({ status: 'invalid', reason: 'invalid_url' });
    expect((await staff.get(link(THIRD))).body.link).toBeNull();
  });

  it('refuses a file without the columns it needs', async () => {
    const r = await staff
      .post('/api/staff/v1/client-links/import')
      .send({ csv: 'name,website\nAcme,https://x.test\n' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('csv_columns');
  });

  it('reads quoted fields with commas, quotes and line breaks', () => {
    expect(parseCsv('\uFEFFa,"b, ""c""\nd"\r\n1,2')).toEqual([
      ['a', 'b, "c"\nd'],
      ['1', '2'],
    ]);
    // A quote inside an unquoted field is a quote, and the next row is still a row.
    expect(parseCsv('a,5" binder,c\nd,e,f')).toEqual([
      ['a', '5" binder', 'c'],
      ['d', 'e', 'f'],
    ]);
  });

  it("a value the download guarded with ' comes back as it was", async () => {
    const r = await imp("client_code,url,message\nACME,https://x.test,'=SUM(1)\n", true);
    expect(r.body.rows[0].status).toBe('new');
    expect((await staff.get(link(THIRD))).body.link.message).toBe('=SUM(1)');
  });
});
