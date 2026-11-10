-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P49: files sent to someone outside the client (a lender, a lawyer), as Vibe Time & Billing's
-- secure share. Staff choose files already on the portal for one client and a recipient's email;
-- the recipient gets a private link, proves the mailbox with a 6-digit code, and may then view
-- (or also download) those files until the link expires or staff end it. No account is made.

CREATE TABLE file_share (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES clients (id),
  -- sha256 of the secret half of the link; the link itself is only ever in the email.
  secret_hash     text NOT NULL,
  recipient_email text NOT NULL,
  recipient_name  text NOT NULL DEFAULT '',
  organization    text NOT NULL DEFAULT '',
  message         text NOT NULL DEFAULT '',
  can_download    boolean NOT NULL DEFAULT false,
  watermark       boolean NOT NULL DEFAULT false,
  created_by      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  -- The staff member, or 'lockout' after too many wrong codes.
  revoked_by      text,
  -- Wrong codes tried since the last right one; at 15 the link is ended.
  wrong_tries     integer NOT NULL DEFAULT 0,
  opens           integer NOT NULL DEFAULT 0,
  first_opened_at timestamptz,
  last_opened_at  timestamptz,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX file_share_client_idx ON file_share (client_id, created_at);
CREATE INDEX file_share_recipient_idx ON file_share (recipient_email);

CREATE TABLE file_share_item (
  share_id uuid NOT NULL REFERENCES file_share (id) ON DELETE CASCADE,
  file_id  uuid NOT NULL REFERENCES files (id),
  PRIMARY KEY (share_id, file_id)
);

-- The 6-digit codes sent to the recipient: one live code per link.
CREATE TABLE file_share_code (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id   uuid NOT NULL REFERENCES file_share (id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX file_share_code_share_idx ON file_share_code (share_id, created_at);

-- A browser that gave the right code: its cookie opens the link's files for half an hour.
CREATE TABLE file_share_grant (
  token_hash text PRIMARY KEY,
  share_id   uuid NOT NULL REFERENCES file_share (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- The history names the outside recipient as who viewed or downloaded.
ALTER TABLE events DROP CONSTRAINT events_actor_kind_check;
ALTER TABLE events ADD CONSTRAINT events_actor_kind_check
  CHECK (actor_kind IN ('firm_key', 'staff', 'client', 'system', 'recipient'));
