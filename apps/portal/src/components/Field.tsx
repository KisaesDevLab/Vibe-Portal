// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A dropdown and a text box labelled the same way as the design system's Input (P59): a small
// muted label above, the control filling the width.

import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { tokens } from '@vibe/ui';

const labelStyle = { fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 } as const;

export function Select({
  label,
  children,
  style,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'block', fontFamily: tokens.font.body }}>
      <div style={labelStyle}>{label}</div>
      <select {...rest} style={{ width: '100%', ...style }}>
        {children}
      </select>
    </label>
  );
}

export function TextArea({
  label,
  style,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }): JSX.Element {
  return (
    <label style={{ display: 'block', fontFamily: tokens.font.body }}>
      <div style={labelStyle}>{label}</div>
      <textarea {...rest} style={{ width: '100%', ...style }} />
    </label>
  );
}
