-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P89: a watermarked secure link from staff may carry a PDF that cannot be watermarked (locked
-- with a password, damaged, or too large): it goes as it is, and staff are told which. The
-- stored content it was allowed for is kept here: once Vibe Files replaces the file's content,
-- the link's watermark rule holds for the new content again.
--
-- (0026 is the access-request check of Addendum 01, on its own branch.)

ALTER TABLE file_share_item ADD COLUMN unmarked_blob_key text;
