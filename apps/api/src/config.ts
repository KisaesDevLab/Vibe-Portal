// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Environment configuration, checked at startup.

import { z } from 'zod';

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().int().positive().default(3101),
  DATABASE_URL: z.string().min(1),
  /** Where encrypted file blobs live (P6). */
  DATA_DIR: z.string().min(1).default('/data/portal'),
  /** The address clients use (P7: its own hostname). */
  PORTAL_URL: z.string().url().default('http://localhost:5197'),
});

export type Config = z.infer<typeof Schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
