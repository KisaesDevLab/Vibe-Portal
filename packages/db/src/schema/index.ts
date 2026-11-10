// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Drizzle view of migrations/0000_init.sql. The SQL files are the source of truth; the test
// `schema-matches-migrations` checks that every column here exists there.

import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** A move of the stored files between the data volume and B2 (P51). */
export interface StorageMove {
  to: 'local' | 'b2';
  state: 'requested' | 'running' | 'done' | 'failed' | 'interrupted';
  by: string;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  copied?: number;
  total?: number;
  error?: string;
  /** Starts after a restart cut it off; past three it waits for someone to move again. */
  attempts?: number;
}

/** What the daily sweep for leftover stored files found (P51). */
export interface StorageNote {
  sweptAt?: string;
  /** Leftovers removed by the last sweep. */
  removed?: number;
  /** The last sweep found too many to be leftovers and removed none. */
  refused?: { at: string; count: number; total: number } | null;
  /** The bucket carries another installation's mark: no sweep runs. */
  otherBucket?: boolean;
  /** The last database snapshot sent to the bucket, and the last failure since. */
  snapshotAt?: string;
  snapshotName?: string;
  snapshotError?: string | null;
  snapshotFailedAt?: string;
}

export const firm = pgTable('firm', {
  id: smallint('id').primaryKey().default(1),
  name: text('name').notNull().default(''),
  logo: bytea('logo'),
  logoType: text('logo_type'),
  accentColor: text('accent_color').notNull().default('#0f6cbd'),
  portalUrl: text('portal_url').notNull().default(''),
  uploadLimitBytes: bigint('upload_limit_bytes', { mode: 'number' }).notNull(),
  uploadKeepDays: integer('upload_keep_days').notNull(),
  /** Where stored files live (P51). */
  storage: text('storage', { enum: ['local', 'b2'] })
    .notNull()
    .default('local'),
  /** Files may still be in the other place: reads look there too, removes reach both. */
  storageOther: boolean('storage_other').notNull().default(false),
  b2Endpoint: text('b2_endpoint').notNull().default(''),
  b2Bucket: text('b2_bucket').notNull().default(''),
  b2KeyId: text('b2_key_id').notNull().default(''),
  /** The B2 application key, wrapped by the firm key. Never sent back to the page. */
  b2AppKeyEnc: bytea('b2_app_key_enc'),
  storageMove: jsonb('storage_move').$type<StorageMove>(),
  /** This installation; written into the bucket it uses (P51). */
  installId: uuid('install_id').notNull().defaultRandom(),
  storageNote: jsonb('storage_note').$type<StorageNote>(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const firmKeys = pgTable('firm_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  label: text('label').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
});

export const staffUsers = pgTable('staff_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  totpSecretEnc: bytea('totp_secret_enc'),
  ssoSubject: text('sso_subject').unique(),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastSignInAt: ts('last_sign_in_at'),
  totpConfirmedAt: ts('totp_confirmed_at'),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: ts('locked_until'),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  /** Uses Settings: the firm, portal keys and staff accounts (P48). */
  admin: boolean('admin').notNull().default(false),
  /** False: sees only the clients in `staff_client` (P48). */
  allClients: boolean('all_clients').notNull().default(true),
});

export const staffSetupToken = pgTable('staff_setup_token', {
  id: uuid('id').primaryKey().defaultRandom(),
  staffId: uuid('staff_id').references(() => staffUsers.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdBy: text('created_by').notNull().default(''),
  createdAt: ts('created_at').notNull().defaultNow(),
  /** Made for the first account (`vibe portal setup-link`). */
  first: boolean('first').notNull().default(false),
});

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey(),
  clientCode: text('client_code').notNull().default(''),
  displayName: text('display_name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** The clients a limited staff member sees (P48); used only while `allClients` is false. */
export const staffClient = pgTable(
  'staff_client',
  {
    staffId: uuid('staff_id')
      .notNull()
      .references(() => staffUsers.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.staffId, t.clientId] })],
);

export const portalIdentity = pgTable('portal_identity', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').unique(),
  phone: text('phone').unique(),
  name: text('name').notNull().default(''),
  notify: text('notify', { enum: ['email', 'sms', 'both', 'none'] })
    .notNull()
    .default('email'),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastSignInAt: ts('last_sign_in_at'),
});

export const clientAccess = pgTable(
  'client_access',
  {
    identityId: uuid('identity_id')
      .notNull()
      .references(() => portalIdentity.id),
    clientId: uuid('client_id')
      .notNull()
      .references(() => clients.id),
    roleLabel: text('role_label').notNull().default(''),
    active: boolean('active').notNull().default(true),
    invitedBy: text('invited_by').notNull().default(''),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.clientId] })],
);

export const portalInvitation = pgTable('portal_invitation', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  email: text('email'),
  phone: text('phone'),
  name: text('name').notNull().default(''),
  roleLabel: text('role_label').notNull().default(''),
  tokenHash: text('token_hash').notNull().unique(),
  invitedBy: text('invited_by').notNull().default(''),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  revokedAt: ts('revoked_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const accessRequest = pgTable('access_request', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  clientAs: text('client_as').notNull().default(''),
  note: text('note').notNull().default(''),
  status: text('status', { enum: ['pending', 'approved', 'denied'] })
    .notNull()
    .default('pending'),
  clientId: uuid('client_id').references(() => clients.id),
  decidedBy: text('decided_by'),
  decidedAt: ts('decided_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  confirmedAt: ts('confirmed_at'),
  confirmedContact: text('confirmed_contact'),
});

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  vfDocumentId: text('vf_document_id').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull().default('application/octet-stream'),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  blobKey: text('blob_key'),
  dekWrapped: bytea('dek_wrapped'),
  sharedAt: ts('shared_at').notNull().defaultNow(),
  sharedBy: text('shared_by').notNull().default(''),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  removedAt: ts('removed_at'),
  removedBy: text('removed_by'),
  taxYear: smallint('tax_year'),
  contentUpdatedAt: ts('content_updated_at'),
});

export const fileVisibility = pgTable(
  'file_visibility',
  {
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => portalIdentity.id),
    visible: boolean('visible').notNull(),
    firstViewedAt: ts('first_viewed_at'),
    changedAt: ts('changed_at').notNull().defaultNow(),
    changedBy: text('changed_by').notNull().default(''),
    viewedAt: ts('viewed_at'),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.identityId] })],
);

export const uploads = pgTable('uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  identityId: uuid('identity_id')
    .notNull()
    .references(() => portalIdentity.id),
  name: text('name').notNull(),
  contentType: text('content_type').notNull().default('application/octet-stream'),
  size: bigint('size', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  blobKey: text('blob_key'),
  dekWrapped: bytea('dek_wrapped'),
  note: text('note').notNull().default(''),
  uploadedAt: ts('uploaded_at').notNull().defaultNow(),
  fetchedAt: ts('fetched_at'),
  fetchedBy: text('fetched_by'),
  purgedAt: ts('purged_at'),
  batchId: uuid('batch_id'),
  removedAt: ts('removed_at'),
  originalName: text('original_name'),
});

export const events = pgTable('events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: ts('at').notNull().defaultNow(),
  kind: text('kind').notNull(),
  actorKind: text('actor_kind', {
    enum: ['firm_key', 'staff', 'client', 'system', 'recipient'],
  }).notNull(),
  actor: text('actor').notNull(),
  clientId: uuid('client_id'),
  fileId: uuid('file_id'),
  uploadId: uuid('upload_id'),
  identityId: uuid('identity_id'),
  detail: jsonb('detail').notNull().default({}),
});

/** Files sent to someone outside the client by a private link (P49). */
export const fileShare = pgTable('file_share', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: uuid('client_id')
    .notNull()
    .references(() => clients.id),
  secretHash: text('secret_hash').notNull(),
  recipientEmail: text('recipient_email').notNull(),
  recipientName: text('recipient_name').notNull().default(''),
  organization: text('organization').notNull().default(''),
  message: text('message').notNull().default(''),
  canDownload: boolean('can_download').notNull().default(false),
  watermark: boolean('watermark').notNull().default(false),
  createdBy: text('created_by').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  /** The staff member, or 'lockout' after too many wrong codes. */
  revokedBy: text('revoked_by'),
  wrongTries: integer('wrong_tries').notNull().default(0),
  opens: integer('opens').notNull().default(0),
  firstOpenedAt: ts('first_opened_at'),
  lastOpenedAt: ts('last_opened_at'),
});

export const fileShareItem = pgTable(
  'file_share_item',
  {
    shareId: uuid('share_id')
      .notNull()
      .references(() => fileShare.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.fileId] })],
);

export const fileShareCode = pgTable('file_share_code', {
  id: uuid('id').primaryKey().defaultRandom(),
  shareId: uuid('share_id')
    .notNull()
    .references(() => fileShare.id, { onDelete: 'cascade' }),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const fileShareGrant = pgTable('file_share_grant', {
  tokenHash: text('token_hash').primaryKey(),
  shareId: uuid('share_id')
    .notNull()
    .references(() => fileShare.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
});

/** A watermarked copy of a PDF in a secure link, kept for the day it names (P49 review). */
export const fileShareMark = pgTable(
  'file_share_mark',
  {
    shareId: uuid('share_id')
      .notNull()
      .references(() => fileShare.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id),
    day: text('day').notNull(),
    sourceBlobKey: text('source_blob_key').notNull(),
    blobKey: text('blob_key').notNull(),
    dekWrapped: bytea('dek_wrapped').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.fileId, t.day] })],
);

export const sessions = pgTable('sessions', {
  idHash: text('id_hash').primaryKey(),
  kind: text('kind', { enum: ['client', 'staff'] }).notNull(),
  subjectId: uuid('subject_id').notNull(),
  activeClientId: uuid('active_client_id'),
  deviceId: text('device_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  keepSignedIn: boolean('keep_signed_in').notNull().default(false),
});

export const signInChallenge = pgTable('sign_in_challenge', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', {
    enum: ['magic_link', 'sms_code', 'request_confirm', 'phone_confirm'],
  }).notNull(),
  identityId: uuid('identity_id').references(() => portalIdentity.id),
  accessRequestId: uuid('access_request_id').references(() => accessRequest.id),
  contact: text('contact').notNull(),
  secretHash: text('secret_hash').notNull(),
  keepSignedIn: boolean('keep_signed_in').notNull().default(false),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const rateLimit = pgTable(
  'rate_limit',
  {
    bucket: text('bucket').notNull(),
    windowStart: ts('window_start').notNull(),
    hits: integer('hits').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] })],
);

export const firmKeyEnvelope = pgTable('firm_key_envelope', {
  firmId: text('firm_id').primaryKey(),
  wrappedMfk: bytea('wrapped_mfk').notNull(),
  kekMetadata: jsonb('kek_metadata').notNull(),
  sentinelCiphertext: bytea('sentinel_ciphertext').notNull(),
  rotationVersion: integer('rotation_version').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const notifyQueue = pgTable('notify_queue', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  identityId: uuid('identity_id')
    .notNull()
    .references(() => portalIdentity.id),
  fileId: uuid('file_id')
    .notNull()
    .references(() => files.id),
  kind: text('kind', { enum: ['shared', 'updated'] }).notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  sentAt: ts('sent_at'),
  droppedAt: ts('dropped_at'),
});
