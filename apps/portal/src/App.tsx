// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client portal routes.

import { ClientPreview } from './staff/ClientPreview';
import { useEffect, useRef } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';

import { AcceptInvitation } from './pages/AcceptInvitation';
import { ConfirmContact } from './pages/ConfirmContact';
import { FileView } from './pages/FileView';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { RequestAccess } from './pages/RequestAccess';
import { Shared } from './pages/Shared';
import { VerifyLink } from './pages/VerifyLink';
import { StaffLogin, StaffSetup } from './staff/StaffAuth';
import { StaffHome } from './staff/StaffPages';

/** A new page (not the first): focus goes to its content, so a screen reader starts there. */
function FocusOnNavigate(): null {
  const { pathname } = useLocation();
  const shown = useRef(pathname);
  useEffect(() => {
    if (shown.current === pathname) return;
    shown.current = pathname;
    // The staff page moves focus itself.
    if (pathname.startsWith('/staff')) return undefined;
    // When the new page's content is there: it may still be loading (for up to 5 s).
    let tries = 0;
    const t = window.setInterval(() => {
      const main = document.getElementById('main-content');
      if (main || ++tries > 50) {
        window.clearInterval(t);
        main?.focus();
      }
    }, 100);
    return () => window.clearInterval(t);
  }, [pathname]);
  return null;
}

export function App(): JSX.Element {
  return (
    <>
      <FocusOnNavigate />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/auth/verify" element={<VerifyLink />} />
        <Route path="/auth/confirm-contact" element={<ConfirmContact />} />
        <Route path="/invite" element={<AcceptInvitation />} />
        <Route path="/request-access" element={<RequestAccess />} />
        <Route path="/files/:id" element={<FileView />} />
        <Route path="/shared" element={<Shared />} />
        <Route path="/staff/login" element={<StaffLogin />} />
        <Route path="/staff/setup" element={<StaffSetup />} />
        <Route path="/staff/preview/:id" element={<ClientPreview />} />
        <Route path="/staff/*" element={<StaffHome />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </>
  );
}
