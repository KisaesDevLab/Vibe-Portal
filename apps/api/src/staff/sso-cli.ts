// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The adapter Vibe Auth's command-line tool uses inside the portal's container (P44), named in
// package.json "vibeAuth.adapter". The appliance runs, when it registers the portal:
//
//   node_modules/.bin/tsx node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass ensure --json
//
// which makes the emergency local admin (vibe-breakglass) if it is missing and prints its
// password once, for the appliance's secret store. `status`, `rotate` and `verify` work too.

import { createDb } from '@vibe-portal/db';

import { loadConfig } from '../config';
import { BREAKGLASS_EMAIL, historySink, staffUsers } from './sso';

export default async function adapter() {
  const config = loadConfig();
  const { db, close } = createDb({ connectionString: config.DATABASE_URL, max: 1 });
  return {
    users: staffUsers(db),
    audit: historySink(db),
    adminRole: 'admin',
    breakglassEmail: BREAKGLASS_EMAIL,
    // Signs in with its password alone until someone sets up an authenticator for it.
    breakglassCheck: () => ({}),
    close,
  };
}
