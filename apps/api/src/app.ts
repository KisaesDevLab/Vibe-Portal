// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The Express app. Routers are added phase by phase (BUILD_PLAN.md §7).

import express, { type Express } from 'express';
import type { HealthResponse } from '@vibe-portal/types';

import { clientAuthRouter } from './auth/client-auth';
import type { Ctx } from './context';
import { firmRouter } from './firm/routes';
import { errorHandler, requireJson, TRUST_CF_IP } from './lib/http';
import { accessRequestsRouter } from './portal/access-requests';
import { invitationsRouter } from './portal/invitations';
import { VERSION } from './version';

export interface AppDeps {
  /** True when the database answers. */
  pingDb: () => Promise<boolean>;
  /** Absent only in tests of /health alone. */
  ctx?: Ctx;
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
    app.use('/api', express.json({ limit: '64kb' }), requireJson);
    app.use('/api', (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });
    app.use('/api/portal/auth', clientAuthRouter(ctx));
    app.use('/api/portal/invitations', invitationsRouter(ctx));
    app.use('/api/portal/access-requests', accessRequestsRouter(ctx));
    app.use('/api/firm/v1', firmRouter(ctx));
  }

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler(deps.ctx?.log ?? console));

  return app;
}
