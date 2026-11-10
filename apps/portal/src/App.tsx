// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Client portal routes.

import { Route, Routes } from 'react-router-dom';

import { AcceptInvitation } from './pages/AcceptInvitation';
import { FileView } from './pages/FileView';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { RequestAccess } from './pages/RequestAccess';
import { VerifyLink } from './pages/VerifyLink';

export function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/auth/verify" element={<VerifyLink />} />
      <Route path="/invite" element={<AcceptInvitation />} />
      <Route path="/request-access" element={<RequestAccess />} />
      <Route path="/files/:id" element={<FileView />} />
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
