// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Request access: the person adds a photo ID (P67) and confirms their email or phone with a code;
// then the firm decides.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, Input } from '@vibe/ui';

import { FirmAuthLayout } from '../branding';
import { api, ApiError, say } from '../api';

type Step =
  { at: 'form' } | { at: 'confirm'; id: string; sentTo: string; idSent: boolean } | { at: 'done' };

/** A phone photo can be large; the portal takes up to 15 MB. */
const ID_MAX_BYTES = 15 * 1024 * 1024;

/** Sends the photo ID for a request (P67). */
async function sendIdPhoto(requestId: string, file: File): Promise<void> {
  if (file.size > ID_MAX_BYTES) throw new ApiError(413, 'too_large');
  const res = await fetch(
    `/api/portal/access-requests/${requestId}/id-photo?name=${encodeURIComponent(file.name)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? 'error');
  }
}

const ID_ACCEPT = 'image/jpeg,image/png,image/heic,image/heif,.heic,.heif,application/pdf';

export function RequestAccess(): JSX.Element {
  const [form, setForm] = useState({ name: '', email: '', phone: '', clientAs: '', note: '' });
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ at: 'form' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
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
      let idSent = false;
      try {
        if (photo) await sendIdPhoto(r.requestId, photo);
        idSent = Boolean(photo);
      } catch (err) {
        setError(say(err));
      }
      setStep({ at: 'confirm', id: r.requestId, sentTo: r.sentTo, idSent });
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

  async function retryPhoto(): Promise<void> {
    if (step.at !== 'confirm' || !photo) return;
    setBusy(true);
    setError('');
    try {
      await sendIdPhoto(step.id, photo);
      setStep({ ...step, idSent: true });
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
      <FirmAuthLayout brand="Client portal" title="Request sent">
        <p role="status">Thank you. The firm will confirm your access and let you know.</p>
        <Link to="/login">Back to sign in</Link>
      </FirmAuthLayout>
    );
  }

  if (step.at === 'confirm') {
    return (
      <FirmAuthLayout brand="Client portal" title="Confirm it is you">
        <form onSubmit={confirm} style={{ display: 'grid', gap: 12 }}>
          <p>We sent a 6-digit code to {step.sentTo}. Enter it to send your request to the firm.</p>
          {!step.idSent && (
            <div style={{ display: 'grid', gap: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span>Photo of your ID (driver&rsquo;s license, state ID or passport)</span>
                <input
                  type="file"
                  accept={ID_ACCEPT}
                  onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                />
              </label>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !photo}
                onClick={() => void retryPhoto()}
              >
                Send photo ID
              </Button>
            </div>
          )}
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
          <Button type="submit" disabled={busy || !step.idSent || code.trim().length !== 6}>
            Confirm
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void resend()}>
            Send a new code
          </Button>
        </form>
      </FirmAuthLayout>
    );
  }

  return (
    <FirmAuthLayout
      brand="Client portal"
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
        <label style={{ display: 'grid', gap: 4 }}>
          <span>Photo of your ID (driver&rsquo;s license, state ID or passport)</span>
          <input
            type="file"
            name="idPhoto"
            accept={ID_ACCEPT}
            aria-required="true"
            onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
          />
          <span style={{ fontSize: 13 }}>
            A photo from your phone or a scan. Only the firm sees it, to check who you are.
          </span>
        </label>
        {error && <p role="alert">{error}</p>}
        <Button
          type="submit"
          disabled={busy || !photo || !(form.email.trim() || form.phone.trim())}
        >
          Send request
        </Button>
      </form>
    </FirmAuthLayout>
  );
}
