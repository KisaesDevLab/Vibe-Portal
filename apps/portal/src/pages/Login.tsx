// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Sign in with an email (a link arrives) or a mobile number (a code arrives).

import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input } from '@vibe/ui';

import { FirmAuthLayout } from '../branding';
import { api, ApiError, say } from '../api';
import { KeepSignedIn } from './KeepSignedIn';

type Step = { at: 'ask' } | { at: 'email' } | { at: 'code'; phone: string };

export function Login(): JSX.Element {
  const navigate = useNavigate();
  const [contact, setContact] = useState('');
  const [keep, setKeep] = useState(false);
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ at: 'ask' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState('');

  async function ask(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFieldError('');
    try {
      const r = await api<{ kind: 'email' | 'phone' }>('/auth/login', {
        body: { contact, keepSignedIn: keep },
      });
      setStep(r.kind === 'phone' ? { at: 'code', phone: contact } : { at: 'email' });
    } catch (err) {
      // About the field: shown under it (and the field marked invalid).
      if (err instanceof ApiError && err.code === 'invalid_contact') setFieldError(say(err));
      else setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (step.at !== 'code') return;
    setBusy(true);
    setError('');
    try {
      await api('/auth/verify-code', { body: { phone: step.phone, code: code.trim() } });
      navigate('/', { replace: true });
    } catch (err) {
      setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  if (step.at === 'email') {
    return (
      <FirmAuthLayout brand="Client portal" title="Check your email">
        <p role="status">
          If that email has access, a sign-in link is on its way. It works once, for 15 minutes.
        </p>
        <Button variant="ghost" onClick={() => setStep({ at: 'ask' })}>
          Use a different email or phone
        </Button>
      </FirmAuthLayout>
    );
  }

  if (step.at === 'code') {
    return (
      <FirmAuthLayout brand="Client portal" title="Enter your code">
        <form onSubmit={verify} style={{ display: 'grid', gap: 12 }}>
          <p>
            If that number has access, a 6-digit code is on its way by text. It works for 5 minutes.
          </p>
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
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setStep({ at: 'ask' })}>
            Send a new code
          </Button>
        </form>
      </FirmAuthLayout>
    );
  }

  return (
    <FirmAuthLayout
      brand="Client portal"
      title="Sign in"
      footer={
        <span>
          New here? <Link to="/request-access">Request access</Link>
        </span>
      }
    >
      <form onSubmit={ask} style={{ display: 'grid', gap: 12 }}>
        <Input
          label="Email or mobile number"
          name="contact"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          error={fieldError || undefined}
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          required
        />
        <KeepSignedIn checked={keep} onChange={setKeep} />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={busy || contact.trim().length < 3}>
          {busy ? 'Sending…' : 'Continue'}
        </Button>
      </form>
    </FirmAuthLayout>
  );
}
