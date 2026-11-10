// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Appends to the `events` history (append-only in the database).

import { schema, type Database } from '@vibe-portal/db';
import type { EventKind } from '@vibe-portal/types';

export interface Actor {
  kind: 'firm_key' | 'staff' | 'client' | 'system';
  /** "PC-NAME\user" for Vibe Files (P15); the identity id for a client. */
  name: string;
}

export async function record(
  db: Database,
  kind: EventKind,
  actor: Actor,
  about: {
    clientId?: string | null;
    identityId?: string | null;
    fileId?: string | null;
    uploadId?: string | null;
    detail?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await db.insert(schema.events).values({
    kind,
    actorKind: actor.kind,
    actor: actor.name,
    clientId: about.clientId ?? null,
    identityId: about.identityId ?? null,
    fileId: about.fileId ?? null,
    uploadId: about.uploadId ?? null,
    detail: about.detail ?? {},
  });
}
