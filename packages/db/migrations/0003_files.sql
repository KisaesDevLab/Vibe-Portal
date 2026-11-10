-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- Phase 3: files to clients.

-- The firm master key, wrapped by a key sealed on the appliance's disk (P6). Same shape as
-- Vibe-Time-Billing's envelope row; one firm per appliance.
CREATE TABLE firm_key_envelope (
  firm_id         text PRIMARY KEY,
  wrapped_mfk     bytea NOT NULL,
  kek_metadata    jsonb NOT NULL,
  sentinel_ciphertext bytea NOT NULL,
  rotation_version integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- P19: the tax year Vibe Files sends, for the client's year filter.
ALTER TABLE files ADD COLUMN tax_year smallint CHECK (tax_year BETWEEN 1990 AND 2100);
-- P20: when "Update on portal" last replaced the content (null: never).
ALTER TABLE files ADD COLUMN content_updated_at timestamptz;

-- P21: when this user last opened the current content (null: new to them). first_viewed_at
-- keeps the first time ever.
ALTER TABLE file_visibility ADD COLUMN viewed_at timestamptz;

-- P18: notifications waiting to be gathered into one message per person.
CREATE TABLE notify_queue (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  identity_id   uuid NOT NULL REFERENCES portal_identity (id) ON DELETE RESTRICT,
  file_id       uuid NOT NULL REFERENCES files (id) ON DELETE RESTRICT,
  kind          text NOT NULL CHECK (kind IN ('shared', 'updated')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz,
  dropped_at    timestamptz
);
CREATE INDEX notify_queue_pending_idx ON notify_queue (identity_id, created_at)
  WHERE sent_at IS NULL AND dropped_at IS NULL;
