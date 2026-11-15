// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Request access: the person adds a photo ID (P67) and confirms their email or phone with a code;
// then the firm decides.
//
// P88: the firm chooses what is asked: no ID, one picture of an ID (as before), or its front
// and back (Addendum 01, layer A: the portal reads the barcode on the back). With front and
// back, each side can be taken with the camera; an ID with no barcode (a passport, an ID from
// another country) is sent front only, and the firm is told.

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Button, CameraCapture, Input } from '@vibe/ui';

import { FirmAuthLayout, useBranding } from '../branding';
import { api, ApiError, say } from '../api';

type Step =
  | { at: 'form' }
  | {
      at: 'confirm';
      id: string;
      sentTo: string;
      idSent: boolean;
      /** Front and back only: the back is with the portal. */
      backSent: boolean;
      /** The back's barcode could not be read: another picture is asked for, once. */
      retake: boolean;
    }
  | { at: 'done' };

type Side = 'front' | 'back';

/** A phone photo can be large; the portal takes up to 15 MB. */
const ID_MAX_BYTES = 15 * 1024 * 1024;

/** Sends one side of the photo ID for a request (P67). For the back, whether its barcode was
 *  read. */
async function sendIdPhoto(requestId: string, file: File, side: Side = 'front'): Promise<boolean> {
  if (file.size > ID_MAX_BYTES) throw new ApiError(413, 'too_large');
  const res = await fetch(
    `/api/portal/access-requests/${requestId}/id-photo${side === 'back' ? '?side=back' : ''}`,
    {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    },
  );
  const data = (await res.json().catch(() => ({}))) as { error?: string; readable?: boolean };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'error');
  return data.readable !== false;
}

const ID_ACCEPT = 'image/jpeg,image/png,image/heic,image/heif,.heic,.heif,application/pdf';
/** With front and back, each side is a picture: a barcode is not read from a PDF. */
const PICTURE_ACCEPT = 'image/jpeg,image/png,image/heic,image/heif,.heic,.heif';

/** The file itself was refused: another must be chosen. Anything else (the network, too many
 *  tries) can be sent again as it is. */
const refusedFile = (err: unknown): boolean =>
  err instanceof ApiError &&
  ['id_type', 'image_too_large', 'photo_unreadable', 'too_large'].includes(err.code);

/** A phone or tablet: the camera is offered first. On a desktop, a file is chosen. */
const hasTouchCamera = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

/** One side of the ID, with front and back: the camera on a phone, or a file. */
function SidePicker(props: {
  side: Side;
  label: string;
  hint?: string;
  file: File | null;
  /** Changed to give the file chooser a fresh start. */
  pick: number;
  onFile: (f: File | null) => void;
  /** False where the request may go on without this picture (the back, taken once already). */
  required?: boolean;
}): JSX.Element {
  const [camera, setCamera] = useState(false);
  // A picture from the camera empties the file chooser, so it does not still name another.
  const [taken, setTaken] = useState(0);

  const name = props.side === 'back' ? 'idBack' : 'idPhoto';
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <label htmlFor={`${name}-file`}>{props.label}</label>
      {hasTouchCamera() && (
        <Button
          id={`${name}-camera`}
          type="button"
          variant="secondary"
          aria-label={`${props.file ? 'Take it again' : 'Use the camera'}: ${props.label}`}
          onClick={() => setCamera(true)}
        >
          {props.file ? 'Take it again' : 'Use the camera'}
        </Button>
      )}
      <input
        key={`${props.pick}-${taken}`}
        id={`${name}-file`}
        type="file"
        name={name}
        accept={PICTURE_ACCEPT}
        aria-required={props.required === false ? undefined : 'true'}
        aria-describedby={props.hint ? `${name}-hint` : undefined}
        onChange={(e) => props.onFile(e.target.files?.[0] ?? null)}
      />
      {props.file && (
        <span role="status" style={{ fontSize: 13 }}>
          Ready to send: {props.file.name}
        </span>
      )}
      {props.hint && (
        <span id={`${name}-hint`} style={{ fontSize: 13 }}>
          {props.hint}
        </span>
      )}
      {camera && (
        <CameraCapture
          single
          title={props.label}
          onClose={() => {
            setCamera(false);
            // Back to where the person was (WCAG 2.4.3).
            document.getElementById(`${name}-camera`)?.focus();
          }}
          onCapture={(blob, meta) => {
            setTaken((n) => n + 1);
            props.onFile(
              blob instanceof File
                ? blob
                : new File([blob], meta.filename ?? `id-${props.side}.jpg`, {
                    type: blob.type || 'image/jpeg',
                  }),
            );
          }}
        />
      )}
    </div>
  );
}

export function RequestAccess(): JSX.Element {
  // What the firm asks for (P88). Until it is known, and from an older server: one picture.
  const mode = useBranding()?.requestIdMode ?? 'photo';
  const [form, setForm] = useState({ name: '', email: '', phone: '', clientAs: '', note: '' });
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ at: 'form' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const [back, setBack] = useState<File | null>(null);
  const [noBarcode, setNoBarcode] = useState(false);
  const [fieldError, setFieldError] = useState({ field: '', text: '' });
  const errorFor = (f: string): string | undefined =>
    fieldError.field === f ? fieldError.text : undefined;
  // Changed to give the file chooser a fresh start (choosing the same file again works).
  const [pick, setPick] = useState(0);
  const [backPick, setBackPick] = useState(0);
  const forget = (): void => {
    setPhoto(null);
    setPick((n) => n + 1);
  };
  const forgetBack = (): void => {
    setBack(null);
    setBackPick((n) => n + 1);
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [k]: e.target.value });
    // What was wrong with this field goes once it is edited.
    setFieldError((f) => (f.field === k ? { field: '', text: '' } : f));
  };
  // The portal asked for the back though this page did not know to (the firm's setting could
  // not be read, or changed since the page opened): it is asked for from then on.
  const [wantsBack, setWantsBack] = useState(false);
  const [wantsFront, setWantsFront] = useState(false);
  // The portal said it does not ask for a side (the firm's setting changed since the page
  // opened): that side is no longer needed.
  const [notAsked, setNotAsked] = useState({ front: false, back: false });
  const refusedSide = (err: unknown, side: Side): boolean => {
    if (!(err instanceof ApiError) || err.code !== 'id_not_asked') return false;
    setNotAsked((n) => ({ ...n, [side]: true }));
    return true;
  };
  const scan = (mode === 'scan' || wantsBack) && !notAsked.back;
  const hasContact = Boolean(form.email.trim() || form.phone.trim());
  // What is still missing before the request can be sent.
  const missing = [
    !hasContact && 'your email or mobile number',
    mode === 'photo' && !photo && 'a photo of your ID',
    scan && !photo && 'the front of your ID',
    scan && !back && !noBarcode && 'the back of your ID',
  ].filter(Boolean);

  async function send(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError('');
    setFieldError({ field: '', text: '' });
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
      let backSent = false;
      let retake = false;
      try {
        if (photo) await sendIdPhoto(r.requestId, photo);
        idSent = Boolean(photo);
      } catch (err) {
        // Chosen again on the next step when the file itself was refused.
        if (refusedFile(err)) forget();
        if (!refusedSide(err, 'front')) setError(say(err));
      }
      if (scan && back && !noBarcode) {
        try {
          retake = !(await sendIdPhoto(r.requestId, back, 'back'));
          backSent = true;
          if (retake) forgetBack();
        } catch (err) {
          if (refusedFile(err)) forgetBack();
          if (!refusedSide(err, 'back')) setError(say(err));
        }
      }
      setStep({ at: 'confirm', id: r.requestId, sentTo: r.sentTo, idSent, backSent, retake });
    } catch (err) {
      // About one field: shown under it (and the field marked invalid).
      const code = err instanceof ApiError ? err.code : '';
      const field =
        code === 'invalid_email'
          ? 'email'
          : code === 'invalid_phone' || code === 'phone_us_only'
            ? 'phone'
            : '';
      if (field) setFieldError({ field, text: say(err) });
      else setError(say(err));
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
      await api(`/access-requests/${step.id}/confirm`, {
        body: {
          code: code.trim(),
          ...(scan && noBarcode && !step.backSent ? { noBarcode: true } : {}),
        },
      });
      setStep({ at: 'done' });
    } catch (err) {
      // The portal no longer has the photo ID: ask for it again.
      if (err instanceof ApiError && err.code === 'id_required') {
        forget();
        setWantsFront(true);
        setStep({ ...step, idSent: false });
      }
      // The firm asks for the back as well (its setting changed, or the back was lost).
      if (err instanceof ApiError && err.code === 'id_back_required') {
        forgetBack();
        setWantsBack(true);
        setStep({ ...step, backSent: false, retake: false });
      }
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
      if (refusedFile(err)) forget();
      if (!refusedSide(err, 'front')) setError(say(err));
    } finally {
      setBusy(false);
    }
  }

  /** The back, sent from the confirm step: the first time, or once more when its barcode could
   *  not be read. The second picture is kept whatever it shows (the firm is told). */
  async function sendBack(): Promise<void> {
    if (step.at !== 'confirm' || !back) return;
    setBusy(true);
    setError('');
    try {
      const readable = await sendIdPhoto(step.id, back, 'back');
      setStep({ ...step, backSent: true, retake: !readable && !step.backSent && !step.retake });
      if (!readable && !step.backSent && !step.retake) forgetBack();
    } catch (err) {
      if (refusedFile(err)) forgetBack();
      if (!refusedSide(err, 'back')) setError(say(err));
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
    const needsFront = (mode !== 'none' || wantsFront) && !step.idSent && !notAsked.front;
    const needsBack = scan && !step.backSent && !noBarcode;
    return (
      <FirmAuthLayout brand="Client portal" title="Confirm it is you">
        <form onSubmit={confirm} style={{ display: 'grid', gap: 12 }}>
          <p>We sent a 6-digit code to {step.sentTo}. Enter it to send your request to the firm.</p>
          {needsFront && (
            <div style={{ display: 'grid', gap: 8 }}>
              {scan ? (
                <SidePicker
                  side="front"
                  label="Front of your ID"
                  file={photo}
                  pick={pick}
                  onFile={setPhoto}
                />
              ) : (
                <label style={{ display: 'grid', gap: 4 }}>
                  <span>Photo of your ID (driver&rsquo;s license, state ID or passport)</span>
                  <input
                    key={pick}
                    type="file"
                    accept={ID_ACCEPT}
                    onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
                  />
                </label>
              )}
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !photo}
                onClick={() => void retryPhoto()}
              >
                {scan ? 'Send the front' : 'Send photo ID'}
              </Button>
            </div>
          )}
          {scan && !step.backSent && (
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                name="noBarcode"
                checked={noBarcode}
                onChange={(e) => setNoBarcode(e.target.checked)}
              />
              <span>
                My ID has no barcode (a passport, or an ID from outside the United States and
                Canada)
              </span>
            </label>
          )}
          {scan && (needsBack || step.retake) && (
            <div style={{ display: 'grid', gap: 8 }}>
              {step.retake && (
                <p role="status" style={{ margin: 0 }}>
                  We could not read the barcode on the back of your ID. Take it once more, flat and
                  in good light, with the whole barcode in the picture. Or go on with the picture
                  you sent: the firm will look at it.
                </p>
              )}
              <SidePicker
                side="back"
                label="Back of your ID"
                file={back}
                // Taken once already: the request may go on without another.
                required={!step.retake}
                pick={backPick}
                onFile={setBack}
              />
              <Button
                type="button"
                variant="secondary"
                disabled={busy || !back}
                onClick={() => void sendBack()}
              >
                Send the back
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
          <Button
            type="submit"
            disabled={busy || needsFront || needsBack || code.trim().length !== 6}
          >
            {busy ? 'Confirming…' : 'Confirm'}
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
        <Input
          label="Your name"
          name="name"
          autoComplete="name"
          value={form.name}
          onChange={set('name')}
          required
        />
        <Input
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          error={errorFor('email')}
          value={form.email}
          onChange={set('email')}
        />
        <Input
          label="Mobile number"
          name="phone"
          type="tel"
          autoComplete="tel"
          error={errorFor('phone')}
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
        {mode === 'photo' && (
          <label style={{ display: 'grid', gap: 4 }}>
            <span>Photo of your ID (driver&rsquo;s license, state ID or passport)</span>
            <input
              key={pick}
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
        )}
        {scan && (
          <>
            <SidePicker
              side="front"
              label="Front of your ID (driver&rsquo;s license or state ID; a passport&rsquo;s photo page)"
              hint="Only the firm sees your ID, to check who you are."
              file={photo}
              pick={pick}
              onFile={setPhoto}
            />
            {!noBarcode && (
              <SidePicker
                side="back"
                label="Back of your ID"
                hint="Flat and in good light, with the whole barcode in the picture."
                file={back}
                pick={backPick}
                onFile={setBack}
              />
            )}
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input
                type="checkbox"
                name="noBarcode"
                checked={noBarcode}
                onChange={(e) => setNoBarcode(e.target.checked)}
              />
              <span>
                My ID has no barcode (a passport, or an ID from outside the United States and
                Canada)
              </span>
            </label>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        {!busy && missing.length > 0 && (
          <p style={{ margin: 0, fontSize: 13 }}>
            To send it, add{' '}
            {missing.length > 2
              ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`
              : missing.join(' and ')}
            .
          </p>
        )}
        <Button type="submit" disabled={busy || missing.length > 0}>
          {busy ? 'Sending…' : 'Send request'}
        </Button>
      </form>
    </FirmAuthLayout>
  );
}
