-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P74: the portal is the safety net for Vibe Files' Portal inbox. A fetched upload is kept until
-- Vibe Files says it was filed (or a person dismissed it in Vibe Files), and the firm's keep
-- period (firm.upload_keep_days) counts from then, not from the fetch. Vibe Files lists what it
-- fetched but has not filed, so any PC can fetch a lost one again.
--
-- A fetcher that does not report filing (Vibe Files 0.1.18 and older) gets filed_at = fetched_at
-- when it claims an upload, as before. Uploads fetched before this migration count as filed when
-- they were fetched.

ALTER TABLE uploads ADD COLUMN filed_at timestamptz;
ALTER TABLE uploads ADD COLUMN filed_by text;
ALTER TABLE uploads ADD COLUMN dismissed_at timestamptz;
ALTER TABLE uploads ADD COLUMN dismissed_by text;

UPDATE uploads SET filed_at = fetched_at, filed_by = fetched_by WHERE fetched_at IS NOT NULL;

-- The fetched-but-not-filed list and the purge.
CREATE INDEX uploads_unfiled ON uploads (fetched_at)
  WHERE fetched_at IS NOT NULL AND filed_at IS NULL AND dismissed_at IS NULL;
