// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// The firm master key (P6), from Vibe-Time-Billing's FirmKeyManager in "sealed-on-disk" mode: the
// master key is stored in the database wrapped by a key-encryption key kept in a file on the
// appliance's data volume. Each file's own key (DEK) is wrapped by the master key.

import { join } from 'node:path';

import { FirmKeyManager, type FirmKeyEnvelopeRow, type FirmKeyStore } from '@vibe/crypto';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@vibe-portal/db';

const FIRM_ID = 'firm';

export interface Keyring {
  wrap(dek: Uint8Array): Uint8Array;
  unwrap(wrapped: Uint8Array): Uint8Array;
}

function store(db: Database): FirmKeyStore {
  return {
    async get(firmId) {
      const [row] = await db
        .select()
        .from(schema.firmKeyEnvelope)
        .where(eq(schema.firmKeyEnvelope.firmId, firmId));
      if (!row) return null;
      return {
        firmId: row.firmId,
        wrappedMfk: new Uint8Array(row.wrappedMfk),
        kekMetadata: row.kekMetadata as FirmKeyEnvelopeRow['kekMetadata'],
        sentinelCiphertext: new Uint8Array(row.sentinelCiphertext),
        rotationVersion: row.rotationVersion,
      };
    },
    async insert(r) {
      await db.insert(schema.firmKeyEnvelope).values({
        firmId: r.firmId,
        wrappedMfk: Buffer.from(r.wrappedMfk),
        kekMetadata: r.kekMetadata,
        sentinelCiphertext: Buffer.from(r.sentinelCiphertext),
        rotationVersion: r.rotationVersion,
      });
    },
    async update(r) {
      await db
        .update(schema.firmKeyEnvelope)
        .set({
          wrappedMfk: Buffer.from(r.wrappedMfk),
          kekMetadata: r.kekMetadata,
          sentinelCiphertext: Buffer.from(r.sentinelCiphertext),
          rotationVersion: r.rotationVersion,
          updatedAt: new Date(),
        })
        .where(eq(schema.firmKeyEnvelope.firmId, r.firmId));
    },
  };
}

/** Unseals the master key, creating it on first start. */
export async function openKeyring(db: Database, dataDir: string): Promise<Keyring> {
  const s = store(db);
  const manager = new FirmKeyManager({ store: s, sealedKeyPath: join(dataDir, '.firm-key.seal') });
  if (await s.get(FIRM_ID)) await manager.unseal({ firmId: FIRM_ID });
  else await manager.bootstrap({ firmId: FIRM_ID, mode: 'sealed-on-disk' });
  return {
    wrap: (dek) => manager.wrapTDek(FIRM_ID, dek),
    unwrap: (wrapped) => manager.unwrapTDek(FIRM_ID, wrapped),
  };
}
