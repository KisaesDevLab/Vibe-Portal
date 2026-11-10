// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// "Keep me signed in on this device" (P12): without it, 30 minutes idle signs the person out.

export function KeepSignedIn({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        Keep me signed in on this device for 7 days
        <br />
        <small>Leave this off on a shared computer.</small>
      </span>
    </label>
  );
}
