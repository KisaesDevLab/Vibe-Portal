// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Staff sign-in and account setup (P9, P36).

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input } from '@vibe/ui';
import QRCode from 'qrcode';

import { FirmAuthLayout } from '../branding';
import { ApiError, tokenFromHash } from '../api';
import { staffApi, staffSay } from './api';

interface FirstAdmin {
  /** The address, masked (k•••@yourfirm.com). */
  to: string;
  /** When the last link went; empty when none has. */
  at: string;
  ok: boolean;
}

function sentAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** No staff account yet (P52): the first one is made from a link emailed to the first admin. */
function FirstAccount({ first }: { first: FirstAdmin | null }): JSX.Element {
  const [state, setState] = useState(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [again, setAgain] = useState(false);

  if (!state) {
    return (
      <div role="status" style={{ display: 'grid', gap: 8 }}>
        <p style={{ margin: 0 }}>
          <strong>This portal has no staff account yet.</strong>
        </p>
        <p style={{ margin: 0 }}>
          Whoever looks after the Vibe appliance can set one up: in the appliance console, open{' '}
          <strong>Settings › Apps › Vibe Portal</strong>, fill in{' '}
          <strong>First admin&rsquo;s email</strong> under <strong>Application</strong>, and save.
          The portal then emails that person a link to make their account. (Or, at the bottom of
          that page, <strong>Get a staff setup link</strong> shows one on the screen.)
        </p>
      </div>
    );
  }

  async function resend(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const r = await staffApi<{ firstAdmin: FirstAdmin }>('/auth/setup/resend', { body: {} });
      setState(r.firstAdmin);
      setAgain(true);
    } catch (err) {
      setError(staffSay(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="status" style={{ display: 'grid', gap: 10 }}>
      <p style={{ margin: 0 }}>
        <strong>Welcome. This portal has no staff account yet.</strong>
      </p>
      {state.ok ? (
        <p style={{ margin: 0 }}>
          {again ? 'A new link was' : 'A link to make the first staff account was'} emailed to{' '}
          <strong>{state.to}</strong>
          {state.at ? ` on ${sentAt(state.at)}` : ''}. Open it on this computer, choose a password,
          and add the portal to an authenticator app on your phone. The link works for 3 days.
        </p>
      ) : (
        <p style={{ margin: 0 }}>
          {state.at
            ? `The setup email to ${state.to} could not be sent.`
            : `A setup email to ${state.to} has not been sent yet.`}{' '}
          Check the portal&rsquo;s email settings in the appliance console (
          <strong>Settings › Apps › Vibe Portal › Email &amp; SMS</strong>; its{' '}
          <strong>Send a test email</strong> button says what is wrong), then press{' '}
          <strong>Send again</strong>.
        </p>
      )}
      <p style={{ margin: 0, fontSize: 14 }}>
        Not there? Look in the junk or spam folder first. Only the newest link works.
      </p>
      {error && <p role="alert">{error}</p>}
      <div>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void resend()}>
          Send again
        </Button>
      </div>
    </div>
  );
}

/** The authenticator's otpauth:// link as a QR code (drawn here: the secret never leaves the
 *  page for a QR service). */
function TotpQr({ url }: { url: string }): JSX.Element | null {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' })
      .then((s) => {
        if (live) setSvg(s);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url]);
  if (!svg) return null;
  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt="QR code for your authenticator app"
      width={220}
      height={220}
      // White behind the code in dark mode too: phone cameras read dark on light.
      style={{ background: '#fff', padding: 8, borderRadius: 8, justifySelf: 'center' }}
    />
  );
}

/** What Vibe Auth's engine says about signing in (P44). */
interface SsoStatus {
  mode: 'local' | 'both' | 'oidc_only';
  oidc: { enabled: boolean; idpName: string; reachable: boolean; startPath: string };
  localLoginVisible: boolean;
}

/** Vibe Auth's sign-in for staff, when the firm has turned it on (P44). */
function useSso(): SsoStatus | null {
  const [s, setS] = useState<SsoStatus | null>(null);
  useEffect(() => {
    staffApi<SsoStatus>('/sso/auth/status')
      .then(setS)
      .catch(() => setS(null));
  }, []);
  return s;
}

function SsoButton({ sso }: { sso: SsoStatus }): JSX.Element {
  const name = sso.oidc.idpName || 'Vibe Auth';
  return (
    <a
      href={`${sso.oidc.startPath}?return_to=${encodeURIComponent('/staff')}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 44,
        borderRadius: 8,
        background: 'var(--vibe-color-accent)',
        color: 'var(--vibe-on-accent, #fff)',
        fontWeight: 600,
        textDecoration: 'none',
      }}
    >
      Sign in with {name}
    </a>
  );
}

export function StaffLogin(): JSX.Element {
  const navigate = useNavigate();
  const sso = useSso();
  // P44: the emergency account's own way in, when only single sign-on is allowed.
  const emergency = new URLSearchParams(window.location.search).has('local');
  const ssoOn = Boolean(sso?.oidc.enabled && sso.mode !== 'local');
  const localShown = !sso || sso.mode !== 'oidc_only' || emergency;
  const [f, setF] = useState({ email: '', password: '', code: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [first, setFirst] = useState<FirstAdmin | null>(null);

  useEffect(() => {
    staffApi<{ setupNeeded: boolean; firstAdmin?: FirstAdmin | null }>('/auth/status')
      .then((s) => {
        setFirst(s.firstAdmin ?? null);
        setSetupNeeded(s.setupNeeded);
      })
      .catch(() => undefined);
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await staffApi('/auth/login', { body: f });
      navigate('/staff', { replace: true });
    } catch (err) {
      setError(staffSay(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FirmAuthLayout brand="Portal staff" title="Staff sign in">
      {ssoOn && sso && !emergency && (
        <div style={{ display: 'grid', gap: 12, marginBottom: 16 }}>
          <SsoButton sso={sso} />
          {!sso.oidc.reachable && (
            <p role="status" style={{ margin: 0, fontSize: 13 }}>
              {sso.oidc.idpName || 'Vibe Auth'} cannot be reached right now.
              {localShown ? ' Sign in below instead.' : ''}
            </p>
          )}
          {localShown && !setupNeeded && (
            <div style={{ textAlign: 'center', fontSize: 13, opacity: 0.7 }}>or</div>
          )}
        </div>
      )}
      {!localShown ? (
        <p style={{ margin: 0, fontSize: 13 }}>
          Staff sign in with {sso?.oidc.idpName || 'Vibe Auth'} only.{' '}
          <a href="/staff/login?local=1">Emergency sign-in</a>
        </p>
      ) : setupNeeded && !emergency ? (
        <FirstAccount first={first} />
      ) : (
        <form onSubmit={submit} style={{ display: 'grid', gap: 12 }}>
          <Input
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
            required
          />
          <Input
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={f.password}
            onChange={(e) => setF({ ...f, password: e.target.value })}
            required
          />
          <Input
            label="Code from your authenticator app"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={f.code}
            onChange={(e) => setF({ ...f, code: e.target.value })}
          />
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={busy}>
            Sign in
          </Button>
        </form>
      )}
    </FirmAuthLayout>
  );
}

type Step =
  | { at: 'loading' }
  | { at: 'form'; first: boolean; email: string; name: string; firm: string }
  | { at: 'authenticator'; url: string; secret: string }
  | { at: 'error'; message: string };

export function StaffSetup(): JSX.Element {
  const navigate = useNavigate();
  // Read once per mount; taken out of the address bar in the effect (a render may be repeated
  // in development, and must still see it).
  const token = useRef(tokenFromHash(window.location.hash));
  const [step, setStep] = useState<Step>({ at: 'loading' });
  const [f, setF] = useState({ email: '', name: '', password: '', again: '', code: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.history.replaceState(null, '', window.location.pathname);
    if (!token.current) {
      // Reloaded part way: the link is no longer in the address bar.
      setStep({ at: 'error', message: staffSay(new ApiError(400, 'setup_link_missing')) });
      return;
    }
    staffApi<{ first: boolean; email: string; name: string; firmName: string }>(
      '/auth/setup/preview',
      { body: { token: token.current } },
    )
      .then((p) => {
        setStep({ at: 'form', first: p.first, email: p.email, name: p.name, firm: p.firmName });
        setF((x) => ({ ...x, email: p.email, name: p.name }));
      })
      .catch((err: unknown) => setStep({ at: 'error', message: staffSay(err) }));
  }, []);

  async function setPassword(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (step.at !== 'form') return;
    if (f.password !== f.again) {
      setError('The two passwords are not the same.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await staffApi<{ otpauthUrl: string; secret: string }>('/auth/setup', {
        body: {
          token: token.current,
          password: f.password,
          ...(step.first ? { email: f.email, name: f.name } : {}),
        },
      });
      setStep({ at: 'authenticator', url: r.otpauthUrl, secret: r.secret });
    } catch (err) {
      setError(staffSay(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await staffApi('/auth/setup/confirm', {
        body: { token: token.current, code: f.code.trim() },
      });
      navigate('/staff', { replace: true });
    } catch (err) {
      setError(staffSay(err));
      setBusy(false);
    }
  }

  if (step.at === 'loading') {
    return (
      <FirmAuthLayout brand="Portal staff" title="Staff account">
        <p role="status">One moment.</p>
      </FirmAuthLayout>
    );
  }
  if (step.at === 'error') {
    return (
      <FirmAuthLayout brand="Portal staff" title="Setup link not valid">
        <p role="alert">{step.message}</p>
        <Link to="/staff/login">Staff sign in</Link>
      </FirmAuthLayout>
    );
  }
  if (step.at === 'authenticator') {
    // The secret groups of four are easier to type.
    const grouped = step.secret.replace(/(.{4})/g, '$1 ').trim();
    return (
      <FirmAuthLayout brand="Portal staff" title="Add the portal to your authenticator app">
        <form onSubmit={confirm} style={{ display: 'grid', gap: 12 }}>
          <p style={{ margin: 0 }}>
            Open your authenticator app (Microsoft Authenticator, Google Authenticator, 1Password,
            …), choose to add an account, and scan this code:
          </p>
          <TotpQr url={step.url} />
          <details>
            <summary>Can&rsquo;t scan it?</summary>
            <p>
              Add the account by hand with this key (time-based), or open this{' '}
              <a href={step.url}>link</a> on the phone that has the app:
            </p>
            <p>
              <code style={{ fontSize: 18, letterSpacing: 1 }}>{grouped}</code>
            </p>
          </details>
          <Input
            label="Then enter the 6-digit code it shows"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={f.code}
            onChange={(e) => setF({ ...f, code: e.target.value })}
            required
          />
          {error && <p role="alert">{error}</p>}
          <Button type="submit" disabled={busy}>
            Finish
          </Button>
        </form>
      </FirmAuthLayout>
    );
  }
  return (
    <FirmAuthLayout
      brand={step.firm}
      title={step.first ? 'Make the first staff account' : 'Finish your staff account'}
    >
      <form onSubmit={setPassword} style={{ display: 'grid', gap: 12 }}>
        {step.first ? (
          <>
            <Input
              label="Your email"
              name="email"
              type="email"
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
              required
            />
            <Input
              label="Your name"
              name="name"
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
              required
            />
          </>
        ) : (
          <p>
            {step.name} ({step.email})
          </p>
        )}
        <Input
          label="Password (12 characters or more)"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={f.password}
          onChange={(e) => setF({ ...f, password: e.target.value })}
          required
        />
        <Input
          label="The password again"
          name="again"
          type="password"
          autoComplete="new-password"
          value={f.again}
          onChange={(e) => setF({ ...f, again: e.target.value })}
          required
        />
        {error && <p role="alert">{error}</p>}
        <Button type="submit" disabled={busy}>
          Next
        </Button>
      </form>
    </FirmAuthLayout>
  );
}
