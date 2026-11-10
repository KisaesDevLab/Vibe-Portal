// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 1: the portal's shell. Sign-in (Phase 2) and Files (Phase 3) replace the holding page.

import { useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { AuthLayout } from '@vibe/ui';
import type { HealthResponse } from '@vibe-portal/types';

type Reach = 'checking' | 'ok' | 'down';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="*" element={<Holding />} />
    </Routes>
  );
}

function Holding(): JSX.Element {
  const [reach, setReach] = useState<Reach>('checking');
  useEffect(() => {
    let live = true;
    fetch('/health')
      .then(async (r) => ((await r.json()) as HealthResponse).status)
      .then((s) => live && setReach(s === 'ok' ? 'ok' : 'down'))
      .catch(() => live && setReach('down'));
    return () => {
      live = false;
    };
  }, []);
  const message: Record<Reach, string> = {
    checking: 'Checking the portal…',
    ok: 'The portal is running. Sign-in is not open yet.',
    down: 'The portal cannot be reached right now. Try again later.',
  };
  return (
    <AuthLayout brand="Client Portal" title="Welcome">
      <p role="status">{message[reach]}</p>
    </AuthLayout>
  );
}
