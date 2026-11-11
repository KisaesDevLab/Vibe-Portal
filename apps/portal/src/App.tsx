// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client portal routes.

import { Route, Routes } from 'react-router-dom';

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

export function App(): JSX.Element {
  return (
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
      <Route path="/staff/*" element={<StaffHome />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
