// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Express helpers: async handlers, body validation, errors, client address.

import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';

/** Wraps an async handler so a rejected promise reaches the error handler. */
export function h(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function body<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  return schema.parse(req.body) as z.infer<S>;
}

/** An error with an HTTP status and a stable code for the caller. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export function errorHandler(log: { error: (o: object, m: string) => void }): ErrorRequestHandler {
  return (err: unknown, _req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'invalid', fields: err.issues.map((i) => i.path.join('.')) });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    log.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal' });
  };
}

/**
 * State-changing requests must be JSON or have no body and no content type: a cross-site HTML
 * form always sends a form content type, and cannot send JSON without CORS.
 */
export const requireJson: RequestHandler = (req, res, next) => {
  const changes = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
  const typed = req.headers['content-type'] !== undefined;
  const hasBody = typed || Number(req.headers['content-length'] ?? 0) > 0;
  if (changes && hasBody && !req.is('application/json')) {
    res.status(415).json({ error: 'json_required' });
    return;
  }
  next();
};

/** The client address behind Caddy: first hop of X-Forwarded-For, else the socket. */
export function clientIp(req: Request): string {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.ip ?? '0.0.0.0').trim();
}
