-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P58: a firm-wide limit on how many times each secure link to someone outside may be
-- downloaded (Settings > Firm, 5 unless changed; 0 for no limit). Each link keeps the limit set
-- when it was made. Links made before this have none.

ALTER TABLE firm ADD COLUMN share_download_limit integer NOT NULL DEFAULT 5
  CHECK (share_download_limit BETWEEN 0 AND 1000);
ALTER TABLE file_share
  ADD COLUMN download_limit integer NOT NULL DEFAULT 0,
  ADD COLUMN downloads integer NOT NULL DEFAULT 0;
