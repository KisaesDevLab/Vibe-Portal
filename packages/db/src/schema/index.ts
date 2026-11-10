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

export const firm = pgTable('firm', {
  id: smallint('id').primaryKey().default(1),
  name: text('name').notNull().default(''),
  logo: bytea('logo'),
  logoType: text('logo_type'),
  accentColor: text('accent_color').notNull().default('#0f6cbd'),
  portalUrl: text('portal_url').notNull().default(''),
  uploadLimitBytes: bigint('upload_limit_bytes', { mode: 'number' }).notNull(),
  uploadKeepDays: integer('upload_keep_days').notNull(),
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
});

export const clients = pgTable('clients', {
  id: uuid('id').primaryKey(),
  clientCode: text('client_code').notNull().default(''),
  displayName: text('display_name').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

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
});

export const events = pgTable('events', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  at: ts('at').notNull().defaultNow(),
  kind: text('kind').notNull(),
  actorKind: text('actor_kind', { enum: ['firm_key', 'staff', 'client', 'system'] }).notNull(),
  actor: text('actor').notNull(),
  clientId: uuid('client_id'),
  fileId: uuid('file_id'),
  uploadId: uuid('upload_id'),
  identityId: uuid('identity_id'),
  detail: jsonb('detail').notNull().default({}),
});

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
  kind: text('kind', { enum: ['magic_link', 'sms_code', 'request_confirm'] }).notNull(),
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
