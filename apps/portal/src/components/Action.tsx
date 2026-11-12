// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// One look for every action on a row (P59): Open, Download, Send securely, Hide, Remove. Same
// height, corners, icon and label whether it goes to a page (router link), saves a file
// (download link) or does something (button). At least 40 px tall, 44 on a phone, for fingers.

import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { tokens, useIsNarrow } from '@vibe/ui';

/** blue, green, violet, red: one colour per kind of action, tinted (owner 2026-11-11: Open
 *  blue, Download green, Share violet, Remove and End red). */
type Colour = 'blue' | 'green' | 'violet' | 'red';
type Tone = 'default' | 'primary' | 'danger' | 'quiet' | Colour;
const COLOURS: readonly string[] = ['blue', 'green', 'violet', 'red'];

/** The class that sets a tone's colours for the theme (portal.css), or none. */
function toneClass(tone: Tone): string | undefined {
  if (tone === 'quiet') return 'p-quiet';
  return COLOURS.includes(tone) ? `p-act is-${tone}` : undefined;
}

function look(tone: Tone, narrow: boolean, disabled = false): CSSProperties {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: narrow ? 44 : 36,
    padding: '0 12px',
    borderRadius: tokens.radius.md,
    fontFamily: tokens.font.body,
    fontSize: 14,
    fontWeight: 500,
    lineHeight: 1,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: `1px solid ${tokens.color.border}`,
    background: tokens.color.surface,
    color: tokens.color.text,
    boxSizing: 'border-box',
  };
  if (disabled) {
    return { ...base, color: tokens.color.textMuted, background: tokens.color.bg };
  }
  if (tone === 'primary') {
    return {
      ...base,
      background: tokens.color.accent,
      borderColor: 'transparent',
      color: 'var(--vibe-on-accent, #fff)',
    };
  }
  if (tone === 'danger') {
    return { ...base, color: tokens.color.danger, borderColor: tokens.color.danger };
  }
  if (COLOURS.includes(tone)) {
    return {
      ...base,
      border: '1px solid var(--p-act-border)',
      background: 'var(--p-act-bg)',
      color: 'var(--p-act-fg)',
    };
  }
  if (tone === 'quiet') {
    // Owner 2026-11-11 (modern look): a row's less used actions are text and icon, boxed only
    // when pointed at (.p-quiet), so a list is not a wall of buttons.
    return { ...base, borderColor: 'transparent', background: 'transparent' };
  }
  return base;
}

interface Common {
  icon?: ReactNode;
  label: string;
  /** The accessible name when the label alone is not enough ("Download W-2.pdf"). */
  ariaLabel?: string;
  tone?: Tone;
  style?: CSSProperties;
}

/** An action that does something. */
export function ActionButton({
  icon,
  label,
  ariaLabel,
  tone = 'default',
  disabled,
  pressed,
  onClick,
  style,
}: Common & {
  disabled?: boolean;
  /** A toggle (the document being viewed): said to screen readers too. */
  pressed?: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
}): JSX.Element {
  const narrow = useIsNarrow();
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={toneClass(tone)}
      style={{ ...look(tone, narrow, disabled), ...style }}
    >
      {icon}
      {label}
    </button>
  );
}

/** An action that goes to a page of the portal. */
export function ActionLink({
  icon,
  label,
  ariaLabel,
  tone = 'default',
  to,
  state,
  onClick,
  style,
}: Common & { to: string; state?: unknown; onClick?: () => void }): JSX.Element {
  const narrow = useIsNarrow();
  return (
    <Link
      to={to}
      state={state}
      aria-label={ariaLabel}
      onClick={onClick}
      className={toneClass(tone)}
      style={{ ...look(tone, narrow), ...style }}
    >
      {icon}
      {label}
    </Link>
  );
}

/** An action that saves a file. */
export function ActionDownload({
  icon,
  label,
  ariaLabel,
  tone = 'default',
  href,
  filename,
  onClick,
  style,
}: Common & { href: string; filename: string; onClick?: () => void }): JSX.Element {
  const narrow = useIsNarrow();
  return (
    <a
      href={href}
      download={filename}
      aria-label={ariaLabel}
      onClick={onClick}
      className={toneClass(tone)}
      style={{ ...look(tone, narrow), ...style }}
    >
      {icon}
      {label}
    </a>
  );
}

/** A row of actions: beside the item on a computer, a full-width row of equal buttons under it
 *  on a phone. */
export function Actions({ children }: { children: ReactNode }): JSX.Element {
  const narrow = useIsNarrow();
  return (
    <div
      style={
        narrow
          ? {
              // Equal buttons in a row, wrapping onto a second row when they do not fit (three
              // actions at 320px wide).
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
              gap: 8,
              width: '100%',
            }
          : { display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }
      }
    >
      {children}
    </div>
  );
}

/** One item in a list: title line, details line, and its actions. */
export function ItemRow({
  title,
  badge,
  meta,
  actions,
  icon,
  bare,
}: {
  title: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** A file-kind tile before the title (home page). */
  icon?: ReactNode;
  /** In a .p-list, which draws the lines between rows itself. */
  bare?: boolean;
}): JSX.Element {
  const narrow = useIsNarrow();
  return (
    <li
      style={{
        display: 'flex',
        flexDirection: narrow ? 'column' : 'row',
        alignItems: narrow ? 'stretch' : 'center',
        gap: narrow ? 10 : 16,
        padding: bare ? '14px 0' : '12px 0',
        ...(bare ? {} : { borderBottom: `1px solid ${tokens.color.border}` }),
      }}
    >
      <div
        style={{ minWidth: 0, flex: '1 1 auto', display: 'flex', gap: 14, alignItems: 'center' }}
      >
        {icon}
        <div style={{ minWidth: 0, flex: '1 1 auto', display: 'grid', gap: 2 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ overflowWrap: 'anywhere', fontWeight: 600, lineHeight: 1.4 }}>
              {title}
            </strong>
            {badge}
          </div>
          {meta && (
            <small
              style={{
                color: tokens.color.textMuted,
                fontSize: 13,
                lineHeight: 1.45,
                overflowWrap: 'anywhere',
              }}
            >
              {meta}
            </small>
          )}
        </div>
      </div>
      {/* Beside the item, the actions keep their width: a long name wraps, never the buttons. */}
      {actions && (narrow ? actions : <div style={{ flex: 'none' }}>{actions}</div>)}
    </li>
  );
}
