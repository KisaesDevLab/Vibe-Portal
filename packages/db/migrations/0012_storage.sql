-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P51: stored files may live in a Backblaze B2 bucket instead of the data volume. An admin enters
-- the bucket and an application key on Settings > Storage (the key encrypted with the firm key),
-- and moves the files there or back. Files are encrypted before they leave the appliance.

ALTER TABLE firm
  ADD COLUMN storage text NOT NULL DEFAULT 'local' CHECK (storage IN ('local', 'b2')),
  -- True while files may still be in the other place (a move under way or not finished): reads
  -- look there too, and removes reach both.
  ADD COLUMN storage_other boolean NOT NULL DEFAULT false,
  ADD COLUMN b2_endpoint text NOT NULL DEFAULT '',
  ADD COLUMN b2_bucket text NOT NULL DEFAULT '',
  ADD COLUMN b2_key_id text NOT NULL DEFAULT '',
  ADD COLUMN b2_app_key_enc bytea,
  -- The last move: { to, state, by, startedAt, finishedAt, copied, total, error }.
  ADD COLUMN storage_move jsonb;
