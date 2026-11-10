// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Request access: the person confirms their email or phone with a code; then the firm decides.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AuthLayout, Button, Input } from '@vibe/ui';

import { api, say } from '../api';

type Step = { at: 'form' } | { at: 'confirm'; id: string; sentTo: string } | { at: 'done' };

export function RequestAccess(): JSX.Element {
  const [form, setForm] = useState({ name: '', email: '', phone: '', clientAs: '', note: '' });
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ at: 'form' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });

  async function send(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ requestId: string; sentTo: string }>('/access-requests', {
        body: {
          name: form.name,
          clientAs: form.clientAs,
          ...(form.email.trim() ? { email: form.email } : {}),
          ...(form.phone.trim() ? { phone: form.phone } : {}),
          ...(form.note.trim() ? { note: form.note } : {}),
        },
      });
      setStep({ at: 'confirm', id: r.requestId, sentTo: r.sentTo });
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (step.at !== 'confirm') return;
    setBusy(true);
    setError('');
    try {
      await api(`/access-requests/${step.id}/confirm`, { body: { code: code.trim() } });
      setStep({ at: 'done' });
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend(): Promise<void> {
    if (step.at !== 'confirm') return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ sentTo: string }>(`/access-requests/${step.id}/resend`, {
        method: 'POST',
      });
      setCode('');
      setStep({ ...step, sentTo: r.sentTo });
      setError('');
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  if (step.at === 'done') {
    return (
      <AuthLayout brand="Client Portal" title="Request sent">
        <p role="status">Thank you. The firm will confirm your access and let you know.</p>
        <Link to="/login">Back to sign in</Link>
      </AuthLayout>
    );
  }

  if (step.at === 'confirm') {
    return (
      <AuthLayout brand="Client Portal" title="Confirm it is you">
        <form onSubmit={confirm} style={{ display: 'grid', gap: 12 }}>
          <p>We sent a 6-digit code to {step.sentTo}. Enter it to send your request to the firm.</p>
          <Input
            label="Code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={busy || code.trim().length !== 6}>
            Confirm
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void resend()}>
            Send a new code
          </Button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      brand="Client Portal"
      title="Request access"
      footer={
        <span>
          Already have access? <Link to="/login">Sign in</Link>
        </span>
      }
    >
      <form onSubmit={send} style={{ display: 'grid', gap: 12 }}>
        <Input label="Your name" name="name" value={form.name} onChange={set('name')} required />
        <Input label="Email" name="email" type="email" value={form.email} onChange={set('email')} />
        <Input
          label="Mobile number"
          name="phone"
          type="tel"
          value={form.phone}
          onChange={set('phone')}
          hint="Give an email, a mobile number, or both. We send a code to confirm it."
        />
        <Input
          label="Whose files? (your name, or the business or family name the firm knows)"
          name="clientAs"
          value={form.clientAs}
          onChange={set('clientAs')}
          required
        />
        <Input
          label="Note to the firm (optional)"
          name="note"
          value={form.note}
          onChange={set('note')}
        />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={busy || !(form.email.trim() || form.phone.trim())}>
          Send request
        </Button>
      </form>
    </AuthLayout>
  );
}
