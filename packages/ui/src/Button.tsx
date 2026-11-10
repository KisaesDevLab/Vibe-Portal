// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
// Copied from Vibe-Time-Billing packages/ui/src/Button.tsx @ 4b14d2f5
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { tokens } from './tokens';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  children: ReactNode;
}

const variantStyle = (variant: ButtonProps['variant']) => {
  switch (variant) {
    case 'danger':
      return { background: tokens.color.danger, color: '#fff', border: 'none' };
    case 'secondary':
      return {
        background: 'transparent',
        color: tokens.color.text,
        border: `1px solid ${tokens.color.border}`,
      };
    case 'ghost':
      return { background: 'transparent', color: tokens.color.text, border: 'none' };
    case 'primary':
    default:
      // Vibe Portal (P59): black or white text, whichever reads on the firm colour.
      return {
        background: tokens.color.accent,
        color: 'var(--vibe-on-accent, #fff)',
        border: 'none',
      };
  }
};

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  style,
  ...rest
}: ButtonProps): JSX.Element {
  const padding = size === 'sm' ? '6px 10px' : '10px 16px';
  const fontSize = size === 'sm' ? 12 : 14;
  return (
    <button
      type={rest.type ?? 'button'}
      style={{
        padding,
        fontSize,
        borderRadius: tokens.radius.md,
        fontFamily: tokens.font.body,
        fontWeight: 500,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        opacity: rest.disabled ? 0.5 : 1,
        ...variantStyle(variant),
        // Vibe Portal (P54): a filled button that cannot be used yet is plain grey, so a faded
        // firm colour is never mistaken for a ready one.
        ...(rest.disabled && (variant === 'primary' || variant === 'danger')
          ? {
              background: tokens.color.border,
              color: tokens.color.textMuted,
              opacity: 1,
            }
          : {}),
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
