-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- Vibe Portal initial schema (BUILD_PLAN.md §2). One firm per appliance.

CREATE TABLE firm (
  id            smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name          text NOT NULL DEFAULT '',
  logo          bytea,
  logo_type     text,
  accent_color  text NOT NULL DEFAULT '#0f6cbd',
  portal_url    text NOT NULL DEFAULT '',
  -- P1: the firm sets the per-file upload limit; default 100 MB.
  upload_limit_bytes bigint NOT NULL DEFAULT 104857600 CHECK (upload_limit_bytes > 0),
  -- P8: fetched client uploads are purged this many days after fetch.
  upload_keep_days integer NOT NULL DEFAULT 30 CHECK (upload_keep_days >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO firm (id) VALUES (1);

-- Keys Vibe Files uses for the firm API (D7). Only the hash is stored.
CREATE TABLE firm_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label         text NOT NULL,
  key_hash      text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- Staff accounts for the staff web page (D13, P9). With Vibe Auth, `sso_subject` is set and
-- there is no password.
CREATE TABLE staff_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text,
  totp_secret_enc bytea,
  sso_subject   text UNIQUE,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  CHECK (password_hash IS NOT NULL OR sso_subject IS NOT NULL)
);

-- A client of the firm, keyed by its Vibe Files client identity.
CREATE TABLE clients (
  id            uuid PRIMARY KEY,
  client_code   text NOT NULL DEFAULT '',
  display_name  text NOT NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- A person who signs in to the portal.
CREATE TABLE portal_identity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE,
  phone         text UNIQUE,
  name          text NOT NULL DEFAULT '',
  notify        text NOT NULL DEFAULT 'email' CHECK (notify IN ('email', 'sms', 'both', 'none')),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz,
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- Identity <-> client (D5): a client can have several users, a user several clients.
CREATE TABLE client_access (
  identity_id   uuid NOT NULL REFERENCES portal_identity (id) ON DELETE RESTRICT,
  client_id     uuid NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
  role_label    text NOT NULL DEFAULT '',
  active        boolean NOT NULL DEFAULT true,
  invited_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (identity_id, client_id)
);
CREATE INDEX client_access_client_idx ON client_access (client_id);

CREATE TABLE portal_invitation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
  email         text,
  phone         text,
  name          text NOT NULL DEFAULT '',
  role_label    text NOT NULL DEFAULT '',
  token_hash    text NOT NULL UNIQUE,
  invited_by    text NOT NULL DEFAULT '',
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

-- Self sign-up (D5): staff approve and link to a client.
CREATE TABLE access_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text,
  phone         text,
  client_as     text NOT NULL DEFAULT '',
  note          text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  client_id     uuid REFERENCES clients (id) ON DELETE RESTRICT,
  decided_by    text,
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL),
  CHECK ((status = 'approved') = (client_id IS NOT NULL))
);
CREATE INDEX access_request_pending_idx ON access_request (created_at) WHERE status = 'pending';

-- A copy of a cabinet file shared with a client (D8, D9). The blob is encrypted with its own
-- data key, wrapped by the firm master key (P6).
CREATE TABLE files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
  vf_document_id text NOT NULL,
  name          text NOT NULL,
  content_type  text NOT NULL DEFAULT 'application/octet-stream',
  size          bigint NOT NULL CHECK (size >= 0),
  sha256        text NOT NULL,
  blob_key      text,
  dek_wrapped   bytea,
  shared_at     timestamptz NOT NULL DEFAULT now(),
  shared_by     text NOT NULL DEFAULT '',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  removed_by    text,
  -- A removed file has no blob left.
  CHECK (removed_at IS NULL OR blob_key IS NULL)
);
CREATE INDEX files_client_idx ON files (client_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX files_live_document_idx ON files (client_id, vf_document_id) WHERE removed_at IS NULL;

-- Per-user visibility (D8): one row per user per file.
CREATE TABLE file_visibility (
  file_id       uuid NOT NULL REFERENCES files (id) ON DELETE RESTRICT,
  identity_id   uuid NOT NULL REFERENCES portal_identity (id) ON DELETE RESTRICT,
  visible       boolean NOT NULL,
  first_viewed_at timestamptz,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  changed_by    text NOT NULL DEFAULT '',
  PRIMARY KEY (file_id, identity_id)
);
CREATE INDEX file_visibility_identity_idx ON file_visibility (identity_id) WHERE visible;

-- A file a client sent the firm (D10).
CREATE TABLE uploads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients (id) ON DELETE RESTRICT,
  identity_id   uuid NOT NULL REFERENCES portal_identity (id) ON DELETE RESTRICT,
  name          text NOT NULL,
  content_type  text NOT NULL DEFAULT 'application/octet-stream',
  size          bigint NOT NULL CHECK (size >= 0),
  sha256        text NOT NULL,
  blob_key      text,
  dek_wrapped   bytea,
  note          text NOT NULL DEFAULT '',
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  fetched_at    timestamptz,
  fetched_by    text,
  purged_at     timestamptz,
  CHECK (purged_at IS NULL OR blob_key IS NULL),
  CHECK ((fetched_at IS NULL) = (fetched_by IS NULL))
);
CREATE INDEX uploads_unfetched_idx ON uploads (uploaded_at) WHERE fetched_at IS NULL;

-- Append-only history, read by Vibe Files for its audit trail.
CREATE TABLE events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('firm_key', 'staff', 'client', 'system')),
  actor         text NOT NULL,
  client_id     uuid,
  file_id       uuid,
  upload_id     uuid,
  identity_id   uuid,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX events_client_idx ON events (client_id, id);

CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only';
END;
$$;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();

-- Sessions for client users and staff (Postgres-backed; no Redis).
CREATE TABLE sessions (
  id_hash       text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('client', 'staff')),
  subject_id    uuid NOT NULL,
  active_client_id uuid,
  device_id     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE INDEX sessions_subject_idx ON sessions (kind, subject_id);
