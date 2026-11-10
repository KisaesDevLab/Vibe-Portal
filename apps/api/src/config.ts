// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Environment configuration, checked at startup.

import { z } from 'zod';

/** An env value; blank counts as not set (env templates leave "SMTP_USER=" empty). */
const opt = (s: z.ZodTypeAny = z.string()) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), s.optional());
const flag = (dflt: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(dflt)
    .transform((v) => v === 'true');

const Schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.string().default('info'),
    PORT: z.coerce.number().int().positive().default(3101),
    DATABASE_URL: z.string().min(1),
    /** Where encrypted file blobs and the key file live (P6, P28). */
    DATA_DIR: z.string().min(1).default('/data/portal'),
    /** The address clients use (P7: its own hostname). */
    PORTAL_URL: z.string().url().default('http://localhost:5197'),
    /** The built client portal (apps/portal/dist), served by the API in the container. */
    STATIC_DIR: opt(),
    /**
     * Count rate limits by Cloudflare's CF-Connecting-IP (the portal is reached through the
     * Cloudflare Tunnel). Turn off only when the portal is reached some other way.
     */
    TRUST_CF_CONNECTING_IP: flag('true'),

    // P38: email by SMTP, texts by Twilio. "console" only logs (development).
    EMAIL_PROVIDER: z.enum(['smtp', 'console']).default('console'),
    EMAIL_FROM: opt(),
    SMTP_HOST: opt(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: opt(),
    SMTP_PASS: opt(),
    SMTP_SECURE: flag('false'),
    SMS_PROVIDER: z.enum(['twilio', 'console', 'none']).default('console'),
    TWILIO_ACCOUNT_SID: opt(),
    TWILIO_AUTH_TOKEN: opt(),
    TWILIO_FROM_NUMBER: opt(),
    TWILIO_MESSAGING_SERVICE_SID: opt(),
  })
  .superRefine((c, ctx) => {
    const need = (ok: boolean, path: string, message: string) => {
      if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    };
    if (c.EMAIL_PROVIDER === 'smtp') {
      need(!!c.SMTP_HOST, 'SMTP_HOST', 'required when EMAIL_PROVIDER=smtp');
      need(!!c.EMAIL_FROM, 'EMAIL_FROM', 'required when EMAIL_PROVIDER=smtp');
    }
    if (c.SMS_PROVIDER === 'twilio') {
      need(!!c.TWILIO_ACCOUNT_SID, 'TWILIO_ACCOUNT_SID', 'required when SMS_PROVIDER=twilio');
      need(!!c.TWILIO_AUTH_TOKEN, 'TWILIO_AUTH_TOKEN', 'required when SMS_PROVIDER=twilio');
      need(
        !!(c.TWILIO_FROM_NUMBER || c.TWILIO_MESSAGING_SERVICE_SID),
        'TWILIO_FROM_NUMBER',
        'TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID is required when SMS_PROVIDER=twilio',
      );
    }
    // Phase 2 follow-up: the console senders log sign-in links and codes; never in production.
    if (c.NODE_ENV === 'production') {
      need(c.EMAIL_PROVIDER !== 'console', 'EMAIL_PROVIDER', 'must be smtp in production');
      need(c.SMS_PROVIDER !== 'console', 'SMS_PROVIDER', 'must be twilio or none in production');
    }
  });

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data as Config;
}
