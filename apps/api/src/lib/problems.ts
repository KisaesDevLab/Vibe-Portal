// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P64: the server's warnings and errors, kept in the database for the staff page's Log, so an
// admin can read why something did not work without the appliance's container logs.
//
// A second destination of the server's logger: each line at warn or above becomes a row. Only
// the message, the error's message and short plain values are kept; any field whose name looks
// like a secret is dropped, and no stack is kept. Writing a row never logs (a failure to write
// is dropped), so the log cannot feed itself.

import { lt } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

type Detail = Record<string, string | number | boolean>;
interface Row {
  at: Date;
  level: 'warning' | 'error';
  msg: string;
  detail: Detail;
}

/** pino's numbers: 40 warn, 50 error, 60 fatal. */
const WARN = 40;
const ERROR = 50;
/** Lines before the database is open (startup), kept until it is. */
const MAX_PENDING = 200;
const SECRET = /key|secret|token|passw|cookie|authoriz|code|otp/i;
/** pino's own fields, and the error (taken apart below). */
const SKIP = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'err', 'v']);

const short = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One log line as a row, or null when it is below a warning or not a log line. */
export function toRow(line: string): Row | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const level = typeof o['level'] === 'number' ? o['level'] : 0;
  if (level < WARN) return null;
  const detail: Detail = {};
  const err = o['err'];
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) detail['error'] = short(m, 500);
  }
  for (const [k, v] of Object.entries(o)) {
    if (SKIP.has(k) || SECRET.test(k)) continue;
    if (typeof v === 'string') detail[k] = short(v, 300);
    else if (typeof v === 'number' || typeof v === 'boolean') detail[k] = v;
  }
  return {
    at: new Date(typeof o['time'] === 'number' ? o['time'] : Date.now()),
    level: level >= ERROR ? 'error' : 'warning',
    msg: short(typeof o['msg'] === 'string' && o['msg'] ? o['msg'] : 'problem', 300),
    detail,
  };
}

export class ProblemLog {
  private db: Database | null = null;
  private pending: Row[] = [];

  /** A pino destination: give it the lines at warn and above. */
  readonly stream = {
    write: (line: string): void => {
      const row = toRow(line);
      if (!row) return;
      if (this.db) this.save(this.db, [row]);
      else if (this.pending.length < MAX_PENDING) this.pending.push(row);
    },
  };

  /** From now on rows go to this database; what came before it opened goes first. */
  attach(db: Database): void {
    this.db = db;
    const rows = this.pending;
    this.pending = [];
    if (rows.length) this.save(db, rows);
  }

  private save(db: Database, rows: Row[]): void {
    void db
      .insert(schema.problemLog)
      .values(rows)
      .catch(() => undefined);
  }
}

const DAY = 24 * 3_600_000;
export const KEEP_DAYS = 30;

/** Rows older than the keep period (run with the daily housekeeping). */
export async function purgeProblems(db: Database, now: Date): Promise<void> {
  await db
    .delete(schema.problemLog)
    .where(lt(schema.problemLog.at, new Date(now.getTime() - KEEP_DAYS * DAY)));
}
