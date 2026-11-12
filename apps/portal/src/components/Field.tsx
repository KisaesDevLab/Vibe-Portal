// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// A dropdown and a text box labelled the same way as the design system's Input (P59): a label
// above, the control filling the width. Labels are 13 px in the text colour (owner 2026-11-11:
// readability; they were 12 px grey).

import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { Input, Search, tokens, type InputProps } from '@vibe/ui';

const labelStyle = {
  fontSize: 13,
  fontWeight: 500,
  color: tokens.color.text,
  marginBottom: 6,
} as const;

/** A search box with a magnifier inside it. */
export function SearchField(props: InputProps): JSX.Element {
  return (
    <div className="p-search">
      <Input type="search" {...props} />
      <Search size={16} />
    </div>
  );
}

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
