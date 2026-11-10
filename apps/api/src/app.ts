// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The Express app. Routers are added phase by phase (BUILD_PLAN.md §7).

import express, { type Express } from 'express';
import type { HealthResponse } from '@vibe-portal/types';

import { clientAuthRouter } from './auth/client-auth';
import type { Ctx } from './context';
import { firmRouter, staffApi } from './firm/routes';
import { vibeAuthExpress } from '@kisaesdevlab/vibe-auth';

import { requireStaff, staffAuthRouter } from './staff/auth';
import { SSO_BASE } from './staff/sso';
import { brandingRouter, staffSettingsRouter } from './staff/settings';
import { errorHandler, requireJson, TRUST_CF_IP } from './lib/http';
import { accountRouter } from './portal/account';
import { accessRequestsRouter } from './portal/access-requests';
import { clientFilesRouter } from './portal/files';
import { clientSharesRouter } from './portal/client-shares';
import { sharedRouter } from './portal/shared';
import { clientUploadsRouter, type HeicConverter } from './portal/uploads';
import { invitationsRouter } from './portal/invitations';
import { serveClient } from './lib/static';
import { VERSION } from './version';

export interface AppDeps {
  /** True when the database answers. */
  pingDb: () => Promise<boolean>;
  /** Absent only in tests of /health alone. */
  ctx?: Ctx;
  /** HEIC to JPG (P33); tests may pass their own. */
  convertHeic?: HeicConverter;
  /** The built client portal, served at / (the container). */
  staticDir?: string;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Rate limits count by Cloudflare's client address behind the tunnel (see lib/http.ts).
  app.set(TRUST_CF_IP, deps.ctx?.trustCfIp ?? false);
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.get('/health', async (_req, res) => {
    const dbOk = await deps.pingDb();
    const body: HealthResponse = {
      status: dbOk ? 'ok' : 'degraded',
      version: VERSION,
      db: dbOk ? 'ok' : 'down',
    };
    res.status(dbOk ? 200 : 503).json(body);
  });

  if (deps.ctx) {
    const ctx = deps.ctx;
    // A staff member's client list can be long (up to 20,000 ids): that route takes more.
    app.use('/api/staff/v1/staff', express.json({ limit: '1mb' }));
    // JSON bodies only; file uploads (application/octet-stream) are streamed by their route.
    app.use('/api', express.json({ limit: '64kb' }));
    // Cookie-signed client calls must be JSON (no cross-site form posts). The firm API is
    // authorised by a bearer key, which a cross-site form cannot send.
    app.use('/api/portal', requireJson);
    app.use('/api', (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    app.use('/api/portal/auth', clientAuthRouter(ctx));
    app.use('/api/portal/invitations', invitationsRouter(ctx));
    app.use('/api/portal/access-requests', accessRequestsRouter(ctx));
    app.use('/api/portal/files', clientFilesRouter(ctx));
    // The signed-in person's own account: the mobile number they sign in with (P50).
    app.use('/api/portal/account', accountRouter(ctx));
    app.use('/api/portal/uploads', clientUploadsRouter(ctx, deps.convertHeic));
    // Someone outside the client, with a secure link (P49): no account, no session.
    app.use('/api/portal/shared', sharedRouter(ctx));
    // P55: a client sending files shared with them to someone outside, when the firm allows.
    app.use('/api/portal/outside-shares', clientSharesRouter(ctx));
    app.use('/api/firm/v1', firmRouter(ctx));
    // P44: Vibe Auth's routes (staff sign-in by single sign-on). Before the JSON-only rule: the
    // identity provider posts back-channel logout as a form.
    if (ctx.sso) {
      app.use(
        SSO_BASE,
        express.urlencoded({ extended: false, limit: '64kb' }),
        vibeAuthExpress(ctx.sso),
      );
    }
    // The staff web page (D13): staff sign-in, then the firm API's work and Settings.
    app.use('/api/staff', requireJson);
    app.use('/api/staff/auth', staffAuthRouter(ctx));
    app.use(
      '/api/staff/v1',
      requireStaff(ctx),
      staffSettingsRouter(ctx),
      staffApi(ctx, (_req, _res, next) => next()),
    );
    app.use('/api/portal/branding', brandingRouter(ctx));
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  if (deps.staticDir) {
    serveClient(app, deps.staticDir, deps.ctx?.portalUrl.startsWith('https://') ?? false);
  }
  app.use(errorHandler(deps.ctx?.log ?? console));

  return app;
}
