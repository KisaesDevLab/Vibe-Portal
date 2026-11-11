// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P65: a client's own history on its page: what happened on it, and its people's sign-ins.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CLIENT, OTHER, world, type World } from './harness';

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.close();
});

interface Ev {
  id: number;
  kind: string;
  who: string;
  person: string | null;
}

describe('a client history (P65)', () => {
  it("shows the client's events and its people's sign-ins, not another client's", async () => {
    await w.member('mary@example.test', CLIENT);
    await w.member('bob@example.test', OTHER);
    const res = await w.firm('get', `/clients/${CLIENT}/history`).expect(200);
    const events = res.body.events as Ev[];
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('invite');
    expect(kinds).toContain('invite_accepted');
    // Newest first.
    const ids = events.map((e) => e.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    // Every row is about Mary, never Bob (of the other client).
    expect(JSON.stringify(events)).not.toContain('bob@');
    expect(events.find((e) => e.kind === 'invite')).toEqual(
      expect.objectContaining({ who: 'Vibe Files (THGR18C-XA003\\kurt)', person: null }),
    );
    const accepted = events.find((e) => e.kind === 'invite_accepted');
    expect(accepted?.person ?? accepted?.who).toBe('mary@example.test');

    // A page at a time.
    const first = await w.firm('get', `/clients/${CLIENT}/history?limit=1`).expect(200);
    expect(first.body.events).toHaveLength(1);
    const rest = await w
      .firm('get', `/clients/${CLIENT}/history?before=${first.body.events[0].id}`)
      .expect(200);
    expect(rest.body.events).toHaveLength(events.length - 1);
  });

  it('includes a sign-in of someone who can see the client', async () => {
    const { agent } = await w.member('mary@example.test', CLIENT);
    await agent.post('/api/portal/auth/logout').expect(200);
    const res = await w.firm('get', `/clients/${CLIENT}/history`).expect(200);
    const out = (res.body.events as Ev[]).find((e) => e.kind === 'sign_out');
    expect(out).toEqual(expect.objectContaining({ who: 'mary@example.test' }));
    const other = await w.firm('get', `/clients/${OTHER}/history`).expect(200);
    expect((other.body.events as Ev[]).some((e) => e.kind === 'sign_out')).toBe(false);
  });

  it('is not found for an unknown client', async () => {
    await w.firm('get', '/clients/33333333-3333-4333-8333-333333333333/history').expect(404);
  });
});
