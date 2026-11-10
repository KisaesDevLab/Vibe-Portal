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
  // The header itself, not req.is(): req.is() says "no" for a JSON-typed request with no body.
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const hasBody = type !== '' || Number(req.headers['content-length'] ?? 0) > 0;
  if (changes && hasBody && type !== 'application/json') {
    res.status(415).json({ error: 'json_required' });
    return;
  }
  next();
};

/** App setting: take the client address from Cloudflare's CF-Connecting-IP header. */
export const TRUST_CF_IP = 'trustCfConnectingIp';

/**
 * The address rate limits count by. Never the first entry of X-Forwarded-For: the client writes
 * that, and Cloudflare keeps it (QA 2026-11-09). Behind the Cloudflare Tunnel (P7, D3),
 * CF-Connecting-IP is set by Cloudflare and cannot be forged through it; otherwise the socket.
 */
export function clientIp(req: Request): string {
  if (req.app.get(TRUST_CF_IP)) {
    const cf = req.header('cf-connecting-ip')?.trim();
    if (cf && cf.length <= 45 && /^[0-9a-fA-F:.]+$/.test(cf)) return cf;
  }
  return req.socket.remoteAddress ?? '0.0.0.0';
}
