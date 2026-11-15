// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
// Copied from Vibe-Time-Billing packages/ui/src/CameraCapture.tsx @ 4b14d2f5
//
// Phone document scanner shared by the intake page and the portal. Opens
// the rear camera, lets the visitor snap multiple pages, and hands each
// frame back as a JPEG blob.
//
// Android hardening (2026-09): real resolution + continuous focus, main
// rear lens preferred on multi-camera phones, shutter disabled until the
// first frame is decodable, actionable error copy, and a native
// "Take a photo" fallback (<input capture>) that works in every browser
// and WebView — including the in-app browsers that have no getUserMedia.
//
// Deferred: jscanify/OpenCV edge detection + perspective crop.
//
// Changed here (Vibe Portal, Addendum 01): `single` takes one picture and closes, for the two
// sides of a photo ID on the request page. As a modal dialog it takes the focus when it opens,
// keeps Tab inside, and closes on Escape (WCAG 2.1.2, 2.4.3); the opener puts focus back.
// `computer` is for a desktop's webcam: no "Phone camera" or "Take a photo" (they would only
// open a file chooser there), and errors worded for a computer.

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  PHOTO_CAPTURE_ACCEPT,
  buildScanConstraints,
  describeCameraError,
  hasCameraApi,
  pickRearCamera,
  type CameraErrorCopy,
} from './camera';
import { tokens } from './tokens';

export interface CameraCaptureProps {
  /** Called once per captured page (canvas frame) or per native photo. */
  onCapture: (blob: Blob, meta: { source: 'scanner' | 'native'; filename?: string }) => void;
  onClose: () => void;
  /** Dialog title / aria-label. */
  title?: string;
  /** One picture, then the dialog closes (no page count, one file from the phone's camera). */
  single?: boolean;
  /** A computer's webcam, not a phone: nothing here offers the phone's camera app. */
  computer?: boolean;
}

type Phase = 'starting' | 'ready' | 'error';

/** If no decodable frame arrives within this window we stop pretending the
 *  camera is coming up and show the guidance + native-camera fallback.
 *  Some WebViews accept getUserMedia, never fire canplay, and would
 *  otherwise leave the user on a dark screen with a dead shutter. */
const START_TIMEOUT_MS = 6000;

export function CameraCapture({
  onCapture,
  onClose,
  title = 'Scan a document',
  single = false,
  computer = false,
}: CameraCaptureProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The newest onClose, for the key listener below (it is added once).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const within = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])') ?? [],
      );
      const first = within[0];
      const last = within[within.length - 1];
      if (!first || !last) return;
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !dialogRef.current?.contains(at))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const streamRef = useRef<MediaStream | null>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const readyRef = useRef(false);
  const aliveRef = useRef(true);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<Phase>(() => (hasCameraApi() ? 'starting' : 'error'));
  const [error, setError] = useState<CameraErrorCopy | null>(() =>
    hasCameraApi() ? null : describeCameraError(null),
  );
  const [count, setCount] = useState(0);
  const [flash, setFlash] = useState(false);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const failStarting = useCallback(
    (err: unknown) => {
      if (!aliveRef.current || readyRef.current) return;
      setError(describeCameraError(err, computer));
      setPhase('error');
    },
    [computer],
  );

  const attach = useCallback(
    async (stream: MediaStream): Promise<void> => {
      stopStream();
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      // Android Chrome sometimes needs an explicit play() even with
      // autoplay + muted. A rejection is not fatal on its own — the frame
      // may still decode — so the watchdog below is what decides.
      await video.play().catch(() => undefined);
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      watchdogRef.current = setTimeout(() => failStarting(null), START_TIMEOUT_MS);
    },
    [stopStream, failStarting],
  );

  useEffect(() => {
    // Re-arm on every mount: React StrictMode runs effect -> cleanup ->
    // effect in dev, and the cleanup flips this false.
    aliveRef.current = true;
    readyRef.current = false;
    if (!hasCameraApi()) return;
    let cancelled = false;
    async function start(): Promise<void> {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(buildScanConstraints());
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        await attach(stream);

        // Multi-camera phones: labels are visible now that we have
        // permission — move to the main rear lens if we landed on a
        // wide/macro one. Failure to switch is not an error.
        try {
          const track = stream.getVideoTracks()[0];
          const currentId = track?.getSettings().deviceId ?? null;
          const devices = await navigator.mediaDevices.enumerateDevices();
          const better = pickRearCamera(devices, currentId);
          if (better && !cancelled) {
            const swapped = await navigator.mediaDevices.getUserMedia(
              buildScanConstraints(better.deviceId),
            );
            if (cancelled) swapped.getTracks().forEach((t) => t.stop());
            else await attach(swapped);
          }
        } catch {
          /* keep the first stream */
        }
      } catch (err) {
        if (!cancelled) {
          setError(describeCameraError(err, computer));
          setPhase('error');
        }
      }
    }
    void start();
    return () => {
      cancelled = true;
      aliveRef.current = false;
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      stopStream();
    };
  }, [attach, stopStream, computer]);

  function onVideoReady(): void {
    const v = videoRef.current;
    if (!v || v.videoWidth === 0) return;
    readyRef.current = true;
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    setPhase('ready');
  }

  function snap(): void {
    const video = videoRef.current;
    if (!video || !video.videoWidth || phase !== 'ready') return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    setFlash(true);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlash(false), 120);
    canvas.toBlob(
      (blob) => {
        // Encoding a 2560x1440 frame is async, so the dialog may already be
        // closed. Dropping the page is right — the user chose Done/Cancel.
        if (!blob || !aliveRef.current) return;
        onCapture(blob, { source: 'scanner' });
        if (single) onClose();
        else setCount((c) => c + 1);
      },
      'image/jpeg',
      0.92,
    );
  }

  function onNativeFiles(list: FileList | null): void {
    if (!list) return;
    let added = 0;
    for (const f of Array.from(list).slice(0, single ? 1 : undefined)) {
      onCapture(f, { source: 'native', filename: f.name });
      added += 1;
    }
    if (added > 0 && single) onClose();
    else if (added > 0) setCount((c) => c + added);
  }

  const nativeInput = (
    <input
      ref={nativeInputRef}
      type="file"
      accept={PHOTO_CAPTURE_ACCEPT}
      capture="environment"
      multiple={!single}
      style={{ display: 'none' }}
      onChange={(e) => {
        onNativeFiles(e.target.files);
        e.target.value = '';
      }}
    />
  );

  const secondaryButton: React.CSSProperties = {
    padding: '10px 16px',
    background: 'transparent',
    color: '#fff',
    border: '1px solid #666',
    borderRadius: tokens.radius.sm,
    fontSize: 15,
    cursor: 'pointer',
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      style={{
        outline: 'none',
        position: 'fixed',
        inset: 0,
        background: '#000',
        zIndex: 80,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {nativeInput}
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {phase === 'error' && error ? (
          <div
            style={{
              color: '#fff',
              padding: 24,
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              height: '100%',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              maxWidth: 420,
              margin: '0 auto',
            }}
          >
            <strong style={{ fontSize: 17 }}>{error.title}</strong>
            <span style={{ fontSize: 14, lineHeight: 1.5, color: '#ccc' }}>{error.detail}</span>
            {!computer && (
              <button
                type="button"
                onClick={() => nativeInputRef.current?.click()}
                style={{
                  ...secondaryButton,
                  background: '#fff',
                  color: '#000',
                  border: 'none',
                  fontWeight: 600,
                }}
              >
                📷 Take a photo
              </button>
            )}
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={onVideoReady}
              onCanPlay={onVideoReady}
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
            {phase === 'starting' && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  display: 'grid',
                  placeItems: 'center',
                  color: '#ccc',
                  fontSize: 14,
                }}
              >
                Starting camera…
              </div>
            )}
            {flash && (
              <div style={{ position: 'absolute', inset: 0, background: '#fff', opacity: 0.6 }} />
            )}
          </>
        )}
        {count > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 16,
              left: 16,
              background: tokens.color.accent,
              color: '#fff',
              borderRadius: tokens.radius.pill,
              padding: '4px 12px',
              fontSize: 13,
            }}
          >
            {count} page{count === 1 ? '' : 's'} captured
          </span>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 12,
          padding: 16,
          background: '#111',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <button type="button" onClick={onClose} style={secondaryButton}>
          {count > 0 ? 'Done' : 'Cancel'}
        </button>
        {phase !== 'error' && (
          <button
            type="button"
            onClick={snap}
            disabled={phase !== 'ready'}
            aria-label={single ? 'Take the picture' : 'Capture page'}
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background: phase === 'ready' ? '#fff' : '#555',
              border: '4px solid #888',
              cursor: phase === 'ready' ? 'pointer' : 'not-allowed',
            }}
          />
        )}
        {computer ? (
          // Keeps the shutter in the middle.
          <span style={{ width: 64 }} />
        ) : (
          <button
            type="button"
            onClick={() => nativeInputRef.current?.click()}
            style={{ ...secondaryButton, fontSize: 13, padding: '8px 10px' }}
            title="Use your phone's camera app instead"
          >
            📷 Phone camera
          </button>
        )}
      </div>
    </div>
  );
}
