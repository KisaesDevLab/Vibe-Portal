// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Sign in by text" on the signed-in home (P50): add a mobile number, proved by a code texted to
// it, or remove it and sign in by email only.

import { useState, type FormEvent } from 'react';
import { Button, Input } from '@vibe/ui';

import { api, say, type Me } from '../api';

/** A code is on its way to `phone` (masked) and waits to be typed. */
export interface Pending {
  phone: string;
}

export function PhoneSignIn({
  me,
  pending: first = null,
  onChange,
}: {
  me: Me;
  /** A code already sent (by accepting an invitation with "also sign in by text"). */
  pending?: Pending | null;
  onChange: (phone: string | null) => void;
}): JSX.Element {
  const [pending, setPending] = useState<Pending | null>(first);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const current = me.identity.phone;

  async function run(f: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await f();
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  const send = (e: FormEvent): Promise<void> => {
    e.preventDefault();
    return run(async () => {
      const r = await api<{ phone: string }>('/account/phone', { body: { phone: phone.trim() } });
      setPending({ phone: r.phone });
      setCode('');
    });
  };

  const verify = (e: FormEvent): Promise<void> => {
    e.preventDefault();
    return run(async () => {
      const r = await api<{ phone: string }>('/account/phone/verify', {
        body: { code: code.trim() },
      });
      setPending(null);
      setPhone('');
      setDone('Done. You can now sign in with this number: a code comes by text.');
      onChange(r.phone);
    });
  };

  const remove = (): Promise<void> =>
    run(async () => {
      await api('/account/phone', { method: 'DELETE' });
      setDone('Removed. You sign in by email.');
      onChange(null);
    });

  return (
    <section aria-label="Sign in by text" style={{ display: 'grid', gap: 8 }}>
      <h2 style={{ fontSize: 16, margin: 0 }}>Sign in by text</h2>
      {current && !pending && (
        <>
          <p style={{ margin: 0 }}>You can sign in with a code texted to {current}.</p>
          {me.identity.email && (
            <div>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void remove()}>
                Remove this number
              </Button>
            </div>
          )}
        </>
      )}
      {!current && !pending && me.textsOn === false && (
        <p style={{ margin: 0 }}>You sign in by email. This portal does not send text messages.</p>
      )}
      {!current && !pending && me.textsOn !== false && (
        <form onSubmit={(e) => void send(e)} style={{ display: 'grid', gap: 8, maxWidth: 320 }}>
          <p style={{ margin: 0 }}>
            Add a US or Canadian mobile number to sign in with a code by text as well as by email.
          </p>
          <Input
            label="Mobile number"
            name="phone"
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <div>
            <Button type="submit" size="sm" disabled={busy || phone.trim().length < 7}>
              Text me a code
            </Button>
          </div>
        </form>
      )}
      {current && !pending && me.textsOn !== false && (
        <details>
          <summary>Use another number</summary>
          <form
            onSubmit={(e) => void send(e)}
            style={{ display: 'grid', gap: 8, maxWidth: 320, marginTop: 8 }}
          >
            <Input
              label="New mobile number"
              name="phone"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <div>
              <Button type="submit" size="sm" disabled={busy || phone.trim().length < 7}>
                Text me a code
              </Button>
            </div>
          </form>
        </details>
      )}
      {pending && (
        <form onSubmit={(e) => void verify(e)} style={{ display: 'grid', gap: 8, maxWidth: 320 }}>
          <p style={{ margin: 0 }}>
            A 6-digit code is on its way by text to {pending.phone}. It works for 5 minutes.
          </p>
          <Input
            label="Code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="submit" size="sm" disabled={busy || code.trim().length !== 6}>
              Confirm
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {done && <p role="status">{done}</p>}
    </section>
  );
}
