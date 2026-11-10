-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- Phase 2: sign-in challenges, request confirmation (P16), "keep me signed in" (P12) and a
-- Postgres rate limiter.

-- A one-time secret sent to a person: a magic link, an SMS sign-in code, or the code that
-- confirms an access request. Only the hash is stored.
CREATE TABLE sign_in_challenge (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('magic_link', 'sms_code', 'request_confirm')),
  identity_id   uuid REFERENCES portal_identity (id) ON DELETE RESTRICT,
  access_request_id uuid REFERENCES access_request (id) ON DELETE RESTRICT,
  contact       text NOT NULL,
  secret_hash   text NOT NULL,
  keep_signed_in boolean NOT NULL DEFAULT false,
  attempts      integer NOT NULL DEFAULT 0,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'request_confirm') = (access_request_id IS NOT NULL)),
  CHECK (kind = 'request_confirm' OR identity_id IS NOT NULL)
);
CREATE INDEX sign_in_challenge_secret_idx ON sign_in_challenge (secret_hash) WHERE used_at IS NULL;
CREATE INDEX sign_in_challenge_contact_idx ON sign_in_challenge (contact, created_at);

-- P16: only confirmed requests reach staff.
ALTER TABLE access_request ADD COLUMN confirmed_at timestamptz;
DROP INDEX access_request_pending_idx;
CREATE INDEX access_request_pending_idx ON access_request (created_at)
  WHERE status = 'pending' AND confirmed_at IS NOT NULL;

-- P12: idle sign-out unless the person ticked "Keep me signed in on this device".
ALTER TABLE sessions ADD COLUMN keep_signed_in boolean NOT NULL DEFAULT false;

-- Fixed-window counters: `bucket` names what is limited (e.g. "login:contact:+15551234567").
CREATE TABLE rate_limit (
  bucket        text NOT NULL,
  window_start  timestamptz NOT NULL,
  hits          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
