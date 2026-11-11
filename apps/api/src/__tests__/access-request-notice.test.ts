// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P59: staff an admin ticked are emailed when someone confirms a request for access: only staff
// who see every client, active, never the emergency account; once per request; the person's name
// and what they typed, never their contact or note.

import { schema } from '@vibe-portal/db';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSetupLink } from '../staff/auth';
import { totpCode } from '../staff/credentials';
import { BREAKGLASS_EMAIL } from '../staff/sso';
import { CLIENT, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

async function staffMember(
  email: string,
  o: { notify?: boolean; admin?: boolean; active?: boolean; clients?: string[] } = {},
) {
  const [u] = await w.t.db
    .insert(schema.staffUsers)
    .values({
      email,
      name: email.split('@')[0] as string,
      notifyAccessRequests: o.notify ?? true,
      admin: o.admin ?? false,
      active: o.active ?? true,
      allClients: !o.clients,
    })
    .returning();
  for (const c of o.clients ?? []) {
    await w.t.db.insert(schema.staffClient).values({ staffId: u?.id as string, clientId: c });
  }
  return u?.id as string;
}

async function requestAccess(email: string) {
  const created = await request(w.app)
    .post('/api/portal/access-requests')
    .send({
      name: 'Mary Smith',
      email,
      clientAs: 'Smith & Co',
      note: 'Spouse, SSN on file',
    })
    .expect(201);
  return created.body.requestId as string;
}

/** The first admin, signed in on the staff page. */
async function admin(): Promise<ReturnType<typeof request.agent>> {
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

const toStaff = () => w.notes.sent.filter((m) => m.to.endsWith('@example-cpa.test'));

describe('access request notice (P59)', () => {
  it('emails the ticked staff who see every client, once the request is confirmed', async () => {
    await staffMember('ann@example-cpa.test', { admin: true });
    await staffMember('bob@example-cpa.test');
    await staffMember('cy@example-cpa.test', { notify: false });
    await staffMember('dee@example-cpa.test', { clients: [CLIENT] }); // limited: cannot approve
    await staffMember('eve@example-cpa.test', { active: false });
    await staffMember(BREAKGLASS_EMAIL, { admin: true });

    const id = await requestAccess('mary@example.test');
    expect(toStaff()).toHaveLength(0); // not before the person confirms

    const code = w.code('mary@example.test');
    await request(w.app)
      .post(`/api/portal/access-requests/${id}/confirm`)
      .send({ code })
      .expect(200);

    const sent = toStaff();
    expect(sent.map((m) => m.to).sort()).toEqual(['ann@example-cpa.test', 'bob@example-cpa.test']);
    expect(w.notes.sent.some((m) => m.to === BREAKGLASS_EMAIL)).toBe(false);
    const m = w.notes.last('ann@example-cpa.test');
    expect(m.subject).toBe('Access request from Mary Smith');
    expect(m.body).toContain('They say they are with: Smith & Co');
    expect(m.body).toContain('/staff/requests');
    // Their contact and note stay on the staff page.
    expect(m.body).not.toContain('mary@example.test');
    expect(m.body).not.toContain('SSN');

    // A second confirm changes nothing and sends nothing.
    await request(w.app).post(`/api/portal/access-requests/${id}/confirm`).send({ code });
    expect(toStaff()).toHaveLength(2);
  });

  it('an admin ticks it on Settings › Staff, and the change is in History', async () => {
    const agent = await admin();
    const bob = await staffMember('bob@example-cpa.test', { notify: false });
    const list = await agent.get('/api/staff/v1/staff').expect(200);
    expect(list.body.staff.find((s: { id: string }) => s.id === bob).notifyAccessRequests).toBe(
      false,
    );
    await agent
      .patch(`/api/staff/v1/staff/${bob}`)
      .send({ notifyAccessRequests: true })
      .expect(200);
    const after = await agent.get('/api/staff/v1/staff').expect(200);
    expect(after.body.staff.find((s: { id: string }) => s.id === bob).notifyAccessRequests).toBe(
      true,
    );
    const events = await w.t.db.select().from(schema.events);
    expect(
      events.some(
        (e) =>
          e.kind === 'staff_access' &&
          (e.detail as { notifyAccessRequests?: boolean }).notifyAccessRequests === true,
      ),
    ).toBe(true);
  });
});
