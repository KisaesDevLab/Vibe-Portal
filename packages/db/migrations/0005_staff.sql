-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- Phase 6b: the staff web page (D13). Staff sign in with email, password and an authenticator
-- code (P9). Accounts are made from one-time setup links: the first by the appliance's
-- `vibe portal setup-link` (P36), the others from Settings.

ALTER TABLE staff_users ADD COLUMN totp_confirmed_at timestamptz;
ALTER TABLE staff_users ADD COLUMN failed_logins integer NOT NULL DEFAULT 0;
ALTER TABLE staff_users ADD COLUMN locked_until timestamptz;
-- Set when an account is made from a link and not yet finished.
ALTER TABLE staff_users DROP CONSTRAINT staff_users_check;
ALTER TABLE staff_users ADD CONSTRAINT staff_users_sign_in
  CHECK (password_hash IS NOT NULL OR sso_subject IS NOT NULL OR totp_confirmed_at IS NULL);

-- A one-time link to finish a staff account (set password and authenticator). staff_id NULL:
-- the first account of an appliance with none.
CREATE TABLE staff_setup_token (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id      uuid REFERENCES staff_users (id) ON DELETE RESTRICT,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
