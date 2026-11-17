// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// History rows in words for the staff page: a client's History (P65), a person's activity
// (P66) and the History page itself (P103), which can be narrowed by each of its columns.
// Newest first, a page at a time.

import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, gte, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { schema } from '@vibe-portal/db';

import { FOLLOW_ACTOR } from '../files/vf-follow';

import type { Ctx } from '../context';
import { checkWords } from '../portal/access-id';

export const HistoryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  before: z.coerce.number().int().min(1).optional(),
});

/**
 * P103: what narrows the History page, one for each of its columns. Text is looked for
 * anywhere in the column's words, whatever the case. Looked for in the database, so it reaches
 * the whole history, not only the rows the page has read.
 */
export const HistoryFilters = z.object({
  /** When: from this moment, and before this one. */
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** What: one or more kinds, with commas between. */
  kind: z
    .string()
    .max(2000)
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : [])),
  who: z.string().trim().max(100).optional(),
  client: z.string().trim().max(100).optional(),
  file: z.string().trim().max(100).optional(),
  /** About: the person it was about, or a secure link's recipient. */
  about: z.string().trim().max(100).optional(),
});
export type HistoryFilter = z.infer<typeof HistoryFilters>;

const likeText = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export interface HistoryRow {
  id: number;
  at: Date;
  kind: string;
  who: string;
  /** The person it was about, when not the one who did it. */
  person: string | null;
  file: string | null;
  /** A secure link's outside recipient (P49). */
  recipient: string | null;
  /** The client it was on (a person's activity spans their clients). */
  client: string | null;
  /** An approval: how staff checked who was asking (Addendum 01, layer B), in words. */
  check: string | null;
  /** P103: how a message went out: 'email', 'text', 'email and text', 'a copied link'. */
  channel: string | null;
}

/** The check kept with an approval, in the words its PDF uses. */
function checkOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as { method?: unknown; matched?: unknown; note?: unknown };
  const methods = ['record_match', 'callback', 'in_person', 'other', 'vendor'] as const;
  const method = methods.find((m) => m === c.method);
  if (!method) return null;
  const matched = Array.isArray(c.matched)
    ? c.matched.filter((m): m is schema.CheckMatched => ['email', 'mobile', 'dob'].includes(m))
    : [];
  return checkWords({
    checkMethod: method,
    checkMatched: matched,
    checkNote: typeof c.note === 'string' ? c.note : '',
  });
}

/** The person's name, else email, else number. */
const named = (n: string | null, e: string | null, p: string | null): string | null =>
  n || e || p || null;

export async function historyRows(
  ctx: Ctx,
  where: SQL | undefined,
  q: z.infer<typeof HistoryQuery>,
  /** `check: false` leaves out how an approval was checked: the note may name people, and
   *  access requests are for staff who see every client (P48). */
  opts: { check: boolean; filter?: HistoryFilter } = { check: true },
): Promise<HistoryRow[]> {
  const person = alias(schema.portalIdentity, 'person');
  const actorPerson = alias(schema.portalIdentity, 'actor_person');
  const f = opts.filter;
  // Who did it, in the words the row gives (below), so what is typed is found as it is read.
  const whoWords = sql<string>`CASE ${schema.events.actorKind}
    WHEN 'client' THEN coalesce(nullif(${actorPerson.name}, ''), ${actorPerson.email}, ${actorPerson.phone}, 'a client')
    WHEN 'system' THEN CASE WHEN ${schema.events.actor} = ${FOLLOW_ACTOR} THEN ${schema.events.actor} ELSE 'the portal' END
    WHEN 'firm_key' THEN 'Vibe Files (' || ${schema.events.actor} || ')'
    ELSE ${schema.events.actor} END`;
  const narrowed = f
    ? and(
        f.from ? gte(schema.events.at, f.from) : undefined,
        f.to ? lt(schema.events.at, f.to) : undefined,
        f.kind.length ? inArray(schema.events.kind, f.kind as never[]) : undefined,
        f.who ? ilike(whoWords, likeText(f.who)) : undefined,
        f.client
          ? or(
              ilike(schema.clients.displayName, likeText(f.client)),
              ilike(schema.clients.clientCode, likeText(f.client)),
            )
          : undefined,
        f.file
          ? or(
              ilike(schema.files.name, likeText(f.file)),
              ilike(schema.uploads.name, likeText(f.file)),
            )
          : undefined,
        f.about
          ? or(
              ilike(person.name, likeText(f.about)),
              ilike(person.email, likeText(f.about)),
              ilike(person.phone, likeText(f.about)),
              ilike(sql`${schema.events.detail}->>'to'`, likeText(f.about)),
              ilike(sql`${schema.events.detail}->>'invited'`, likeText(f.about)),
              ilike(sql`${schema.events.detail}->>'invitedName'`, likeText(f.about)),
              ilike(sql`${schema.events.detail}->>'channel'`, likeText(f.about)),
            )
          : undefined,
      )
    : undefined;
  const rows = await ctx.db
    .select({
      id: schema.events.id,
      at: schema.events.at,
      kind: schema.events.kind,
      actorKind: schema.events.actorKind,
      actor: schema.events.actor,
      actorName: actorPerson.name,
      actorEmail: actorPerson.email,
      actorPhone: actorPerson.phone,
      personName: person.name,
      personEmail: person.email,
      personPhone: person.phone,
      file: schema.files.name,
      upload: schema.uploads.name,
      client: schema.clients.displayName,
      detail: schema.events.detail,
    })
    .from(schema.events)
    .leftJoin(schema.files, eq(schema.files.id, schema.events.fileId))
    .leftJoin(schema.uploads, eq(schema.uploads.id, schema.events.uploadId))
    .leftJoin(schema.clients, eq(schema.clients.id, schema.events.clientId))
    .leftJoin(person, eq(person.id, schema.events.identityId))
    .leftJoin(
      actorPerson,
      and(
        eq(schema.events.actorKind, 'client'),
        eq(sql`${actorPerson.id}::text`, schema.events.actor),
      ),
    )
    .where(and(q.before ? lt(schema.events.id, q.before) : undefined, where, narrowed))
    .orderBy(desc(schema.events.id))
    .limit(q.limit);
  return rows.map((e) => {
    const who =
      e.actorKind === 'client'
        ? (named(e.actorName, e.actorEmail, e.actorPhone) ?? 'a client')
        : e.actorKind === 'system'
          ? // P94: what the portal did by itself from Vibe Files' bucket is said so.
            e.actor === FOLLOW_ACTOR
            ? e.actor
            : 'the portal'
          : e.actorKind === 'firm_key'
            ? `Vibe Files (${e.actor})`
            : e.actor;
    const d = (e.detail ?? {}) as Record<string, unknown>;
    return {
      id: e.id,
      at: e.at,
      kind: e.kind,
      who,
      // P98: a file chosen for someone invited, who is not a person of the portal yet.
      person:
        named(e.personName, e.personEmail, e.personPhone) ??
        (typeof d['invited'] === 'string' && d['invited']
          ? `${d['invited']} (invited, not accepted yet)`
          : typeof d['invitedName'] === 'string' && d['invitedName']
            ? d['invitedName']
            : null),
      file: e.file ?? e.upload ?? null,
      recipient: typeof d['to'] === 'string' ? d['to'] : null,
      client: e.client ?? null,
      check: opts.check && e.kind === 'approve' ? checkOf(d['check']) : null,
      channel: typeof d['channel'] === 'string' ? d['channel'] : null,
    };
  });
}
