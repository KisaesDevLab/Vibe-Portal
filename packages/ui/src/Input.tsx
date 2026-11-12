// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
// Copied from Vibe-Time-Billing packages/ui/src/Input.tsx @ 4b14d2f5
// Vibe Portal (UI review 2026-11-11): a stable id (useId), the hint and an error tied to the
// field (aria-describedby), the field marked invalid (aria-invalid), and the hint outside the
// label's name.
import { useId, type InputHTMLAttributes } from 'react';

import { tokens } from './tokens';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  invalid?: boolean;
  /** What is wrong with this field, shown under it (and marks it invalid). */
  error?: string;
}

export function Input({
  label,
  hint,
  invalid,
  error,
  id,
  style,
  ...rest
}: InputProps): JSX.Element {
  const auto = useId();
  // Unique on the page even when two forms have a field of the same name.
  const inputId = id ?? `input-${rest.name ? `${rest.name}-` : ''}${auto.replace(/:/g, '')}`;
  const bad = Boolean(invalid || error);
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy =
    [rest['aria-describedby'], hintId, errorId].filter(Boolean).join(' ') || undefined;
  // A page may set a stronger field border (Vibe Portal: --vibe-control-border, 3:1).
  const borderColor = bad
    ? tokens.color.danger
    : 'var(--vibe-control-border, var(--vibe-color-border))';
  return (
    <div style={{ fontFamily: tokens.font.body }}>
      <label htmlFor={inputId} style={{ display: 'block' }}>
        {label && (
          // Vibe Portal (owner 2026-11-11, readability): 13 px in the text colour, not 12 px grey.
          <div style={{ fontSize: 13, fontWeight: 500, color: tokens.color.text, marginBottom: 6 }}>
            {label}
          </div>
        )}
        <input
          id={inputId}
          aria-invalid={bad || undefined}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            padding: '10px 12px',
            background: tokens.color.surface,
            color: tokens.color.text,
            border: `1px solid ${borderColor}`,
            borderRadius: tokens.radius.md,
            fontFamily: tokens.font.body,
            fontSize: 14,
            ...style,
          }}
          {...rest}
          aria-describedby={describedBy}
        />
      </label>
      {hint && (
        <div
          id={hintId}
          style={{
            fontSize: 13,
            color: tokens.color.textMuted,
            marginTop: 4,
          }}
        >
          {hint}
        </div>
      )}
      {error && (
        <div
          id={errorId}
          role="alert"
          style={{ fontSize: 13, color: 'inherit', marginTop: 4, display: 'flex', gap: 6 }}
        >
          <span aria-hidden="true" style={{ color: tokens.color.danger }}>
            ●
          </span>
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
