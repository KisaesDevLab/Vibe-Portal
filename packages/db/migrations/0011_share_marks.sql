-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P49 review: a watermarked PDF is kept once made, per link, file and day, so a recipient who
-- opens it again is not made to wait (and the server not made to work) for the same marking.
-- Encrypted like any stored file. Valid only while the file's content is the one it was made
-- from (source_blob_key); removed once the day is over, the link ends or the file changes.

CREATE TABLE file_share_mark (
  share_id        uuid NOT NULL REFERENCES file_share (id) ON DELETE CASCADE,
  file_id         uuid NOT NULL REFERENCES files (id),
  -- The UTC day written on the mark, YYYY-MM-DD.
  day             text NOT NULL,
  source_blob_key text NOT NULL,
  blob_key        text NOT NULL,
  dek_wrapped     bytea NOT NULL,
  size            bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (share_id, file_id, day)
);
