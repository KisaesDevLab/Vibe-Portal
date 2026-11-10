// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The Express app. Routers are added phase by phase (BUILD_PLAN.md §7).

import express, { type Express } from 'express';
import type { HealthResponse } from '@vibe-portal/types';

import { VERSION } from './version';

export interface AppDeps {
  /** True when the database answers. */
  pingDb: () => Promise<boolean>;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
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

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  return app;
}
