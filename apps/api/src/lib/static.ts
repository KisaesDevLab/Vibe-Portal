// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Serves the built client portal (apps/portal/dist) from the API, so the appliance runs one
// container. Hashed assets are cached for a year; index.html is never cached and carries a
// strict Content-Security-Policy, with its inline start-up scripts allowed by their hashes.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import express, { type Express } from 'express';

/** sha256 CSP sources for each inline <script> in the page. */
export function inlineScriptHashes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1] ?? '';
    out.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return out;
}

export function contentSecurityPolicy(html: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trim(),
    // The design system styles elements inline.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    // pdf.js renders in a worker from the same origin.
    "worker-src 'self' blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function serveClient(app: Express, dir: string, https: boolean): void {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const csp = contentSecurityPolicy(html);
  app.use(
    '/assets',
    express.static(join(dir, 'assets'), { immutable: true, maxAge: '365d', index: false }),
    // A missing asset is a plain 404, never the page.
    (_req, res) => {
      res.status(404).type('text').send('Not found');
    },
  );
  app.use(express.static(dir, { index: false, maxAge: '1h' }));
  // Every other GET is a page of the single-page app.
  app.get(/^(?!\/api\/|\/health$).*/, (_req, res) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
    if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.type('html').send(html);
  });
}
