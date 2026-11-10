// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Phase 5 (Vibe Portal side): settings rules, the Twilio sender, and serving the built client
// portal from the API.

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../app';
import { loadConfig } from '../config';
import { routedNotifier, twilioSender } from '../lib/providers';
import { contentSecurityPolicy, inlineScriptHashes } from '../lib/static';

const log = pino({ level: 'silent' });
const DB = { DATABASE_URL: 'postgres://x' };

describe('settings (P38)', () => {
  it('production refuses the console senders, which log sign-in links and codes', () => {
    expect(() => loadConfig({ ...DB, NODE_ENV: 'production' })).toThrow(/EMAIL_PROVIDER/);
    expect(() =>
      loadConfig({
        ...DB,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        EMAIL_FROM: 'Example CPA <portal@example.test>',
      }),
    ).toThrow(/SMS_PROVIDER/);
    const ok = loadConfig({
      ...DB,
      NODE_ENV: 'production',
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.test',
      EMAIL_FROM: 'Example CPA <portal@example.test>',
      SMS_PROVIDER: 'none',
    });
    expect(ok.SMTP_PORT).toBe(587);
  });

  it('SMTP and Twilio need their settings; blank values count as missing', () => {
    expect(() =>
      loadConfig({ ...DB, EMAIL_PROVIDER: 'smtp', SMTP_HOST: '', EMAIL_FROM: 'a' }),
    ).toThrow(/SMTP_HOST/);
    expect(() =>
      loadConfig({
        ...DB,
        SMS_PROVIDER: 'twilio',
        TWILIO_ACCOUNT_SID: 'AC1',
        TWILIO_AUTH_TOKEN: 't',
      }),
    ).toThrow(/TWILIO_FROM_NUMBER/);
    const c = loadConfig({ ...DB, SMTP_USER: '', STATIC_DIR: '' });
    expect(c.SMTP_USER).toBeUndefined();
    expect(c.STATIC_DIR).toBeUndefined();
  });
});

describe('Twilio sender', () => {
  let server: ReturnType<express.Express['listen']> | null = null;
  afterEach(() => {
    server?.close();
    server = null;
  });

  async function fakeTwilio(status: number) {
    const seen: { path: string; auth: string; form: Record<string, string> }[] = [];
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.post('/2010-04-01/Accounts/:sid/Messages.json', (req, res) => {
      seen.push({
        path: req.path,
        auth: req.header('authorization') ?? '',
        form: req.body as Record<string, string>,
      });
      res.status(status).json(status < 300 ? { sid: 'SM123' } : { message: 'bad number' });
    });
    await new Promise<void>((ok) => {
      server = app.listen(0, ok);
    });
    const port = (server?.address() as AddressInfo).port;
    return { seen, baseUrl: `http://127.0.0.1:${port}` };
  }

  it('posts To, Body and the sending number with basic auth', async () => {
    const { seen, baseUrl } = await fakeTwilio(201);
    const send = twilioSender(
      { accountSid: 'AC1', authToken: 'secret', from: '+15550001111', baseUrl },
      log,
    );
    await send({ channel: 'sms', to: '+15552223333', body: '123456 is your code.' });
    expect(seen).toEqual([
      {
        path: '/2010-04-01/Accounts/AC1/Messages.json',
        auth: `Basic ${Buffer.from('AC1:secret').toString('base64')}`,
        form: { To: '+15552223333', Body: '123456 is your code.', From: '+15550001111' },
      },
    ]);
  });

  it('a messaging service is used instead of a number when given', async () => {
    const { seen, baseUrl } = await fakeTwilio(201);
    const send = twilioSender(
      { accountSid: 'AC1', authToken: 's', messagingServiceSid: 'MG9', from: '+1555', baseUrl },
      log,
    );
    await send({ channel: 'sms', to: '+15552223333', body: 'x' });
    expect(seen[0]?.form).toEqual({ To: '+15552223333', Body: 'x', MessagingServiceSid: 'MG9' });
  });

  it('a Twilio refusal is an error (logged by the caller, never silent)', async () => {
    const { baseUrl } = await fakeTwilio(400);
    const send = twilioSender({ accountSid: 'AC1', authToken: 's', from: '+1555', baseUrl }, log);
    await expect(send({ channel: 'sms', to: '+1', body: 'x' })).rejects.toThrow(/twilio 400/);
  });

  it('a channel with no service drops the message', async () => {
    const sent: string[] = [];
    const n = routedNotifier(
      {
        email: async (m) => {
          sent.push(m.to);
        },
      },
      log,
    );
    await n.send({ channel: 'sms', to: '+1555', body: 'x' });
    await n.send({ channel: 'email', to: 'a@example.test', subject: 's', body: 'x' });
    expect(sent).toEqual(['a@example.test']);
  });
});

describe('serving the client portal', () => {
  let dir = '';
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const THEME = "document.documentElement.dataset.theme='light';";
  const HTML = `<!doctype html><html><head><script>${THEME}</script><script type="module" src="/assets/entry-abc.js"></script></head><body><div id="root"></div></body></html>`;

  async function site() {
    dir = await mkdtemp(join(tmpdir(), 'vibe-portal-web-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), HTML);
    await writeFile(join(dir, 'assets', 'entry-abc.js'), 'console.log(1)');
    return createApp({ pingDb: async () => true, staticDir: dir });
  }

  it('allows only its own inline scripts, by hash', () => {
    const want = `'sha256-${createHash('sha256').update(THEME).digest('base64')}'`;
    expect(inlineScriptHashes(HTML)).toEqual([want]);
    const csp = contentSecurityPolicy(HTML);
    expect(csp).toContain(`script-src 'self' ${want}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('hashes the start-up scripts as a browser reads them, whatever the line ends', async () => {
    // A page built from a Windows checkout has CRLF; the browser hashes the script with LF.
    const body = "\n  document.documentElement.dataset.theme='light';\n";
    const crlf = `<!doctype html><html><head><script>${body.replace(/\n/g, '\r\n')}</script></head><body><div id="root"></div></body></html>`;
    dir = await mkdtemp(join(tmpdir(), 'vibe-portal-web-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), crlf);
    const app = createApp({ pingDb: async () => true, staticDir: dir });
    const res = await request(app).get('/login').expect(200);
    const want = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
    expect(res.headers['content-security-policy']).toContain(want);
    expect(res.text).not.toContain(String.fromCharCode(13));
  });

  it('serves the page for any portal address, and assets with long caching', async () => {
    const app = await site();
    for (const path of ['/', '/login', '/files/123', '/auth/verify']) {
      const res = await request(app).get(path).expect(200);
      expect(res.text).toContain('<div id="root">');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['cache-control']).toBe('no-store');
    }
    const js = await request(app).get('/assets/entry-abc.js').expect(200);
    expect(js.headers['cache-control']).toContain('immutable');
    await request(app).get('/assets/missing.js').expect(404);
  });

  it('API addresses stay JSON, and /health is not the page', async () => {
    const app = await site();
    const api = await request(app).get('/api/nope').expect(404);
    expect(api.body).toEqual({ error: 'not_found' });
    const health = await request(app).get('/health').expect(200);
    expect(health.body.status).toBe('ok');
  });
});

describe('QA 2026-11-09 (Phase 5)', () => {
  it('blank numbers and flags count as not set; flags in any case', () => {
    const c = loadConfig({
      ...DB,
      PORT: '',
      SMTP_PORT: ' ',
      SMTP_SECURE: '',
      TRUST_CF_CONNECTING_IP: 'FALSE',
    });
    expect(c.PORT).toBe(3101);
    expect(c.SMTP_PORT).toBe(587);
    expect(c.SMTP_SECURE).toBeUndefined();
    expect(c.TRUST_CF_CONNECTING_IP).toBe(false);
    expect(loadConfig({ ...DB, SMTP_SECURE: 'True' }).SMTP_SECURE).toBe(true);
    expect(() => loadConfig({ ...DB, SMTP_SECURE: 'yes' })).toThrow(/SMTP_SECURE/);
  });

  it('/index.html is the page, with its CSP and never cached', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vibe-portal-web-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<html><body><div id="root"></div></body></html>');
    const app = createApp({ pingDb: async () => true, staticDir: dir });
    const res = await request(app).get('/index.html').expect(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['cache-control']).toBe('no-store');
    await rm(dir, { recursive: true, force: true });
  });
});
