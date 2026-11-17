// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Reading Vibe Files' part of the B2 bucket (P91): its documents, which Vibe Files encrypts on
// the office PC before they go up. Read only: nothing here writes or deletes under "vf/".
//
// The format is Vibe Files' (its docs/BUCKET_LAYOUT.md, crates vf-sync and vf-security):
//
//   vf/<cabinet id>/cabinet.json        not encrypted: the firm sync key(s), each wrapped by the
//                                       sync passphrase (Argon2id, then ChaCha20-Poly1305 with
//                                       the cabinet id as associated data)
//   vf/<cabinet id>/manifest/HEAD       which segment each client has now
//   vf/<cabinet id>/manifest/clients/<client id>/<rev>[-<writer>]   the client's documents
//   vf/<cabinet id>/objects/<aa>/<name> one document's content
//
// Everything but cabinet.json is "VF1\0 | key id (u16 LE length, UTF-8) | nonce (24) |
// XChaCha20-Poly1305 ciphertext and tag", sealed with the content key (HKDF-SHA256 of the firm
// sync key, salt "vibe-files sync v1", info "content") and its own key below the cabinet as
// associated data. A document's object holds the file as it is, whole.
//
// The tests open a bucket written by Vibe Files itself (__tests__/fixtures/vf-bucket).

import { createHash, hkdfSync } from 'node:crypto';

import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha';
import argon2 from 'argon2';
import { z } from 'zod';

import type { Bucket } from './objects';

/** The firm sync keys of one cabinet, as the portal keeps them (wrapped by its own key). */
export interface VfAccess {
  cabinetId: string;
  /** Key id -> the 32-byte firm sync key, hex. */
  keys: Record<string, string>;
}

/** What went wrong, by a code the staff page has words for. */
export class VfError extends Error {
  constructor(
    readonly code:
      | 'vf_no_cabinet'
      | 'vf_wrong_passphrase'
      | 'vf_format'
      | 'vf_key'
      | 'vf_gone'
      | 'vf_missing'
      | 'vf_damaged',
    detail = '',
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

const Hex = z.string().regex(/^([0-9a-f]{2})+$/i);
const Wrapped = z.object({
  v: z.literal(1),
  kdf: z.literal('argon2id'),
  params: z.object({
    m_kib: z.number().int(),
    t: z.number().int(),
    p: z.number().int(),
  }),
  cipher: z.literal('chacha20poly1305'),
  salt: Hex,
  nonce: Hex,
  ciphertext: Hex,
});
const CabinetJson = z.object({
  cabinet_id: z.string(),
  wrapped: z.record(z.unknown()),
});
const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Head = z.object({
  rev: z.number(),
  segments: z.record(z.number().int().min(0)),
  segment_writers: z.record(z.string()).default({}),
});
const Segment = z.object({
  client_id: z.string(),
  documents: z.array(
    z.object({
      doc_id: z.string(),
      rel_path: z.string(),
      hash: Hash,
      object: Hash,
      size: z.number().int().min(0),
      tax_year: z.number().int().nullable().optional(),
      deleted_at: z.string().nullable().optional(),
    }),
  ),
});

/** A cabinet or client id, or a push's mark, as it may stand in a key. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The firm sync key a wrapped copy holds, or null when the passphrase does not open it. The
 * cost asked for comes from a file anyone with the bucket could have written: an absurd one is
 * refused, not run (as Vibe Files does).
 */
async function unwrap(
  w: z.infer<typeof Wrapped>,
  passphrase: string,
  cabinetId: string,
): Promise<Buffer | null> {
  const { m_kib, t, p } = w.params;
  // Below 1 MiB or 2 passes the Argon2 here does not run; Vibe Files makes keys at 64 MiB and
  // 3 passes.
  if (m_kib > 1024 * 1024 || t > 16 || p > 16 || m_kib < 1024 || t < 2 || p < 1) {
    throw new VfError('vf_format', 'unreasonable key derivation settings');
  }
  const nonce = Buffer.from(w.nonce, 'hex');
  if (nonce.length !== 12) throw new VfError('vf_format', 'nonce length');
  const kek = await argon2.hash(passphrase, {
    type: argon2.argon2id,
    version: 0x13,
    raw: true,
    salt: Buffer.from(w.salt, 'hex'),
    memoryCost: m_kib,
    timeCost: t,
    parallelism: p,
    hashLength: 32,
  });
  try {
    const key = chacha20poly1305(kek, nonce, Buffer.from(cabinetId, 'utf8')).decrypt(
      Buffer.from(w.ciphertext, 'hex'),
    );
    if (key.length !== 32) throw new VfError('vf_format', 'key length');
    return Buffer.from(key);
  } catch (err) {
    if (err instanceof VfError) throw err;
    return null;
  } finally {
    kek.fill(0);
  }
}

/**
 * Finds the cabinet in the bucket that `passphrase` opens, and its firm sync keys. The cabinet
 * id is bound into each wrapped key, so a passphrase opens only its own cabinet.
 */
export async function unlock(bucket: Bucket, passphrase: string): Promise<VfAccess> {
  const cabinets = (await bucket.vfCabinets()).filter((id) => ID.test(id));
  let found = 0;
  for (const cabinetId of cabinets) {
    const raw = await bucket.vfGet(`${cabinetId}/cabinet.json`);
    if (!raw) continue;
    let cab;
    try {
      cab = CabinetJson.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      continue;
    }
    if (cab.cabinet_id !== cabinetId) continue;
    found += 1;
    const keys: Record<string, string> = {};
    for (const [keyId, w] of Object.entries(cab.wrapped)) {
      const parsed = Wrapped.safeParse(w);
      if (!parsed.success) continue;
      const key = await unwrap(parsed.data, passphrase, cabinetId);
      if (key) {
        keys[keyId] = key.toString('hex');
        key.fill(0);
      }
    }
    if (Object.keys(keys).length) return { cabinetId, keys };
  }
  throw new VfError(found ? 'vf_wrong_passphrase' : 'vf_no_cabinet');
}

const MAGIC = Buffer.from('VF1\0', 'latin1');

/** Opens one sealed object. `key` is its key below the cabinet (what it was sealed for). */
export function open(access: VfAccess, body: Buffer, key: string): Buffer {
  if (body.length < 6 || !body.subarray(0, 4).equals(MAGIC)) throw new VfError('vf_format', key);
  const n = body.readUInt16LE(4);
  if (body.length < 6 + n + 24 + 16) throw new VfError('vf_format', key);
  const keyId = body.subarray(6, 6 + n).toString('utf8');
  const firm = access.keys[keyId];
  // Sealed with a key made since the passphrase was entered here.
  if (!firm) throw new VfError('vf_key', keyId);
  const content = Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(firm, 'hex'),
      Buffer.from('vibe-files sync v1'),
      Buffer.from('content'),
      32,
    ),
  );
  try {
    const nonce = body.subarray(6 + n, 6 + n + 24);
    return Buffer.from(
      xchacha20poly1305(content, nonce, Buffer.from(key, 'utf8')).decrypt(
        body.subarray(6 + n + 24),
      ),
    );
  } catch {
    throw new VfError('vf_damaged', key);
  } finally {
    content.fill(0);
  }
}

async function json<T>(
  bucket: Bucket,
  access: VfAccess,
  key: string,
  shape: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T | null> {
  const body = await bucket.vfGet(`${access.cabinetId}/${key}`);
  if (!body) return null;
  const plain = open(access, body, key);
  try {
    return shape.parse(JSON.parse(plain.toString('utf8')));
  } catch {
    throw new VfError('vf_format', key);
  }
}

/** A document as the bucket's manifest has it now. */
export interface VfDocument {
  docId: string;
  /** Its file name. */
  name: string;
  sha256: string;
  size: number;
  taxYear: number | null;
  /** The object's key below the cabinet. */
  objectKey: string;
}

/**
 * The document as the bucket has it now: read from the manifest at this moment, not from the
 * list Vibe Files sent. `vf_gone` when the client or the document is no longer there.
 */
export async function find(
  bucket: Bucket,
  access: VfAccess,
  clientId: string,
  docId: string,
): Promise<VfDocument> {
  const head = await json(bucket, access, 'manifest/HEAD', Head);
  if (!head) throw new VfError('vf_gone', 'nothing pushed');
  const client = Object.keys(head.segments).find((c) => c.toLowerCase() === clientId.toLowerCase());
  if (!client || !ID.test(client)) throw new VfError('vf_gone', 'client');
  const writer = head.segment_writers[client] ?? '';
  if (writer && !ID.test(writer)) throw new VfError('vf_format', 'segment writer');
  const rev = head.segments[client];
  const key = `manifest/clients/${client}/${rev}${writer ? `-${writer}` : ''}`;
  const seg = await json(bucket, access, key, Segment);
  if (!seg) throw new VfError('vf_missing', key);
  const d = seg.documents.find((x) => x.doc_id === docId);
  if (!d || d.deleted_at) throw new VfError('vf_gone', 'document');
  const path = d.rel_path.replace(/\\/g, '/');
  return {
    docId: d.doc_id,
    name: path.slice(path.lastIndexOf('/') + 1),
    sha256: d.hash,
    size: d.size,
    taxYear: d.tax_year ?? null,
    objectKey: `objects/${d.object.slice(0, 2)}/${d.object}`,
  };
}

/** The document's content, checked against the hash the manifest gives for it. */
export async function content(bucket: Bucket, access: VfAccess, doc: VfDocument): Promise<Buffer> {
  const body = await bucket.vfGet(`${access.cabinetId}/${doc.objectKey}`);
  if (!body) throw new VfError('vf_missing', doc.objectKey);
  const plain = open(access, body, doc.objectKey);
  if (createHash('sha256').update(plain).digest('hex') !== doc.sha256) {
    throw new VfError('vf_damaged', doc.objectKey);
  }
  return plain;
}
