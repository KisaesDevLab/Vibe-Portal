-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P44: staff sign-in through Vibe Auth (@kisaesdevlab/vibe-auth). The package's own tables, as its
-- sql/auth_identities.sql defines them, and what a staff session needs to end with the Vibe Auth
-- session it came from (back-channel logout) and to sign out there too (id_token_hint).

CREATE TABLE IF NOT EXISTS auth_identities (
  id              BIGSERIAL PRIMARY KEY,
  user_id         TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  subject         TEXT NOT NULL,
  email           TEXT,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auth_identities_issuer_subject_uq UNIQUE (issuer, subject)
);
CREATE INDEX IF NOT EXISTS auth_identities_user_id_idx ON auth_identities (user_id);

CREATE TABLE IF NOT EXISTS auth_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_revocations (
  subject_key    TEXT PRIMARY KEY,
  revoked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_until  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_revocations_until_idx ON auth_revocations (revoked_until);

-- A staff session that came from Vibe Auth: which identity, and its Vibe Auth session.
ALTER TABLE sessions
  ADD COLUMN oidc_issuer text,
  ADD COLUMN oidc_subject text,
  ADD COLUMN oidc_sid text,
  ADD COLUMN oidc_id_token text;
CREATE INDEX sessions_oidc_sid_idx ON sessions (oidc_sid) WHERE oidc_sid IS NOT NULL;
CREATE INDEX sessions_oidc_subject_idx ON sessions (oidc_issuer, oidc_subject)
  WHERE oidc_subject IS NOT NULL;
