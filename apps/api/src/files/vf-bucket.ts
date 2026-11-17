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

import type { B2Settings } from './b2';
import { VfTooBig, type Bucket } from './objects';

/** The most the portal reads of cabinet.json, and of one manifest object (HEAD, a client's
 *  segment): what is in the bucket is not trusted to be small. */
const CABINET_JSON_MAX = 1024 * 1024;
const MANIFEST_MAX = 64 * 1024 * 1024;
/** Cabinets in one bucket, and wrapped keys in one cabinet, the passphrase is tried on: each
 *  try is an Argon2 run. Vibe Files makes one cabinet with one key ("k-01"). */
const CABINETS_TRIED = 8;
const KEYS_TRIED = 4;
/** The most memory one Argon2 run may ask for (Vibe Files asks for 64 MiB). */
const KDF_MAX_KIB = 256 * 1024;

/** The firm sync keys of one cabinet, as the portal keeps them (wrapped by its own key). */
export interface VfAccess {
  cabinetId: string;
  /** Key id -> the 32-byte firm sync key, hex. */
  keys: Record<string, string>;
  /** P94: Vibe Files' own bucket and a key that reads it, when it is not the bucket the portal
   *  keeps its files in (one with Object Lock, which the portal cannot use for its own). */
  b2?: B2Settings;
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

/** The cost a wrapped key asks for is one the portal runs. It comes from a file anyone with
 *  the bucket could have written: an absurd one is not run. Below 1 MiB or 2 passes the Argon2
 *  here does not run at all; Vibe Files makes keys at 64 MiB and 3 passes. */
function runnable(w: z.infer<typeof Wrapped>): boolean {
  const { m_kib, t, p } = w.params;
  return (
    m_kib >= 1024 &&
    m_kib <= KDF_MAX_KIB &&
    t >= 2 &&
    t <= 16 &&
    p >= 1 &&
    p <= 16 &&
    w.nonce.length === 24
  );
}

/** The firm sync key a wrapped copy holds, or null when the passphrase does not open it. */
async function unwrap(
  w: z.infer<typeof Wrapped>,
  passphrase: string,
  cabinetId: string,
): Promise<Buffer | null> {
  const { m_kib, t, p } = w.params;
  const nonce = Buffer.from(w.nonce, 'hex');
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
    return key.length === 32 ? Buffer.from(key) : null;
  } catch {
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
  // Cabinets found, and those with a key the passphrase could be tried on.
  let found = 0;
  let tried = 0;
  for (const cabinetId of cabinets) {
    if (tried >= CABINETS_TRIED) break;
    let cab;
    try {
      const raw = await bucket.vfGet(`${cabinetId}/cabinet.json`, CABINET_JSON_MAX);
      if (!raw) continue;
      cab = CabinetJson.parse(JSON.parse(raw.toString('utf8')));
    } catch (err) {
      // Not a cabinet file the portal reads (or far too large to be one): the next one.
      if (err instanceof VfTooBig || err instanceof SyntaxError || err instanceof z.ZodError) {
        continue;
      }
      throw err;
    }
    if (cab.cabinet_id !== cabinetId) continue;
    found += 1;
    // A key in a form or at a cost the portal does not run is passed over, not a failure of
    // the whole: another cabinet in the bucket (a trial's leftover) must not stop this one.
    const wrapped = Object.entries(cab.wrapped)
      .map(([keyId, w]) => ({ keyId, w: Wrapped.safeParse(w) }))
      .flatMap(({ keyId, w }) => (w.success && runnable(w.data) ? [{ keyId, w: w.data }] : []))
      .slice(0, KEYS_TRIED);
    if (!wrapped.length) continue;
    tried += 1;
    const keys: Record<string, string> = {};
    for (const { keyId, w } of wrapped) {
      const key = await unwrap(w, passphrase, cabinetId);
      if (key) {
        keys[keyId] = key.toString('hex');
        key.fill(0);
      }
    }
    if (Object.keys(keys).length) return { cabinetId, keys };
  }
  // A cabinet is there, but none with a key the portal can try the passphrase on.
  throw new VfError(tried ? 'vf_wrong_passphrase' : found ? 'vf_format' : 'vf_no_cabinet');
}

const MAGIC = Buffer.from('VF1\0', 'latin1');

/** Opens one sealed object. `key` is its key below the cabinet (what it was sealed for). */
export function open(access: VfAccess, body: Buffer, key: string): Buffer {
  if (body.length < 6 || !body.subarray(0, 4).equals(MAGIC)) throw new VfError('vf_format', key);
  const n = body.readUInt16LE(4);
  if (body.length < 6 + n + 24 + 16) throw new VfError('vf_format', key);
  const keyId = body.subarray(6, 6 + n).toString('utf8');
  // The id is from the object's own header, which nothing vouches for: an own key only.
  const firm = Object.hasOwn(access.keys, keyId) ? access.keys[keyId] : undefined;
  // Sealed with a key made since the passphrase was entered here.
  if (typeof firm !== 'string') throw new VfError('vf_key', 'unknown key id');
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
    const plain = xchacha20poly1305(content, nonce, Buffer.from(key, 'utf8')).decrypt(
      body.subarray(6 + n + 24),
    );
    // The same bytes, not a copy of them (a document can be tens of megabytes).
    return Buffer.from(plain.buffer, plain.byteOffset, plain.length);
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
  let body;
  try {
    body = await bucket.vfGet(`${access.cabinetId}/${key}`, MANIFEST_MAX);
  } catch (err) {
    if (err instanceof VfTooBig) throw new VfError('vf_format', key);
    throw err;
  }
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

/** The manifest's head as the bucket has it now; null when nothing was pushed. */
export async function readHead(bucket: Bucket, access: VfAccess): Promise<VfHead | null> {
  let head;
  try {
    head = await json(bucket, access, 'manifest/HEAD', Head);
  } catch (err) {
    // The manifest's own head does not open with the key kept here: the cabinet's sync key
    // was made anew since the passphrase was entered (Vibe Files names every key "k-01"), far
    // likelier than a damaged HEAD. The passphrase is entered again.
    if (err instanceof VfError && err.code === 'vf_damaged') throw new VfError('vf_key', 'HEAD');
    throw err;
  }
  return head;
}

export type VfHead = z.infer<typeof Head>;

/** The key (below the cabinet) of the client's segment the head names; null when the client
 *  has none in the bucket. It changes whenever anything of the client's does. */
export function segmentKey(head: VfHead, clientId: string): string | null {
  const client = Object.keys(head.segments).find((c) => c.toLowerCase() === clientId.toLowerCase());
  if (!client || !ID.test(client)) return null;
  const writer = head.segment_writers[client] ?? '';
  if (writer && !ID.test(writer)) throw new VfError('vf_format', 'segment writer');
  return `manifest/clients/${client}/${head.segments[client]}${writer ? `-${writer}` : ''}`;
}

/** The client's documents in the bucket by id, from the segment at `key`; one deleted in the
 *  cabinet is left out. */
export async function readSegment(
  bucket: Bucket,
  access: VfAccess,
  key: string,
): Promise<Map<string, VfDocument>> {
  const seg = await json(bucket, access, key, Segment);
  if (!seg) throw new VfError('vf_missing', key);
  const out = new Map<string, VfDocument>();
  for (const d of seg.documents) {
    if (d.deleted_at) continue;
    const path = d.rel_path.replace(/\\/g, '/');
    out.set(d.doc_id, {
      docId: d.doc_id,
      name: path.slice(path.lastIndexOf('/') + 1),
      sha256: d.hash,
      size: d.size,
      taxYear: d.tax_year ?? null,
      objectKey: `objects/${d.object.slice(0, 2)}/${d.object}`,
    });
  }
  return out;
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
  const head = await readHead(bucket, access);
  if (!head) throw new VfError('vf_gone', 'nothing pushed');
  const key = segmentKey(head, clientId);
  if (!key) throw new VfError('vf_gone', 'client');
  const d = (await readSegment(bucket, access, key)).get(docId);
  if (!d) throw new VfError('vf_gone', 'document');
  return d;
}

/** One document at a time is read from the bucket and opened: each is held whole in memory,
 *  and opening it keeps the server busy, so two at once wait their turn. */
let busy: Promise<unknown> = Promise.resolve();
export function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const run = busy.then(job, job);
  busy = run.catch(() => undefined);
  return run;
}

/** The document's content, checked against the hash the manifest gives for it. */
export async function content(bucket: Bucket, access: VfAccess, doc: VfDocument): Promise<Buffer> {
  let body;
  try {
    // The document, its seal's header (the key id is short) and tag: nothing longer is read.
    body = await bucket.vfGet(`${access.cabinetId}/${doc.objectKey}`, doc.size + 4096);
  } catch (err) {
    if (err instanceof VfTooBig) throw new VfError('vf_damaged', doc.objectKey);
    throw err;
  }
  if (!body) throw new VfError('vf_missing', doc.objectKey);
  const plain = open(access, body, doc.objectKey);
  if (createHash('sha256').update(plain).digest('hex') !== doc.sha256) {
    throw new VfError('vf_damaged', doc.objectKey);
  }
  return plain;
}
