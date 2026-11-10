-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- Phase 4: files from clients.

-- P34: files sent together share a batch (at most 20) and its note.
ALTER TABLE uploads ADD COLUMN batch_id uuid;
CREATE INDEX uploads_batch_idx ON uploads (identity_id, batch_id);
-- P32: the client removed it before Vibe Files fetched it.
ALTER TABLE uploads ADD COLUMN removed_at timestamptz;
-- P33: the name the client's file had before a HEIC photo was converted to JPG.
ALTER TABLE uploads ADD COLUMN original_name text;
ALTER TABLE uploads ADD CONSTRAINT uploads_removed_unfetched
  CHECK (removed_at IS NULL OR fetched_at IS NULL);
ALTER TABLE uploads ADD CONSTRAINT uploads_removed_no_blob
  CHECK (removed_at IS NULL OR blob_key IS NULL);

DROP INDEX uploads_unfetched_idx;
CREATE INDEX uploads_unfetched_idx ON uploads (uploaded_at)
  WHERE fetched_at IS NULL AND removed_at IS NULL;
