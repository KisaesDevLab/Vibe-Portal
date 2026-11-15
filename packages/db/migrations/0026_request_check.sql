-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- Addendum 01 (P80-P88): checking who asks for access.
--
-- P88: the firm chooses what a request must carry (no ID, a picture of a photo ID as before
-- (P67), or the front and back with the back's barcode read), and whether staff must say how
-- they checked before Approve works. A firm that updates keeps what it had: one photo ID, no
-- check asked.
--
-- Layer A: the back of the ID, encrypted like the front, and what its barcode said. The
-- licence number is never among the fields kept (P81). The back, the fields and the flags go
-- when the front does (id_removed_at).
--
-- Layer B: how staff checked, kept with the approval and printed in its record.

ALTER TABLE firm ADD COLUMN request_id_mode text NOT NULL DEFAULT 'photo'
  CHECK (request_id_mode IN ('none', 'photo', 'scan'));
ALTER TABLE firm ADD COLUMN request_check text NOT NULL DEFAULT 'off'
  CHECK (request_check IN ('off', 'required'));

ALTER TABLE access_request ADD COLUMN id_back_blob_key text;
ALTER TABLE access_request ADD COLUMN id_back_dek_wrapped bytea;
ALTER TABLE access_request ADD COLUMN id_back_content_type text;
ALTER TABLE access_request ADD COLUMN id_back_size bigint;
ALTER TABLE access_request ADD COLUMN id_scan jsonb;
ALTER TABLE access_request ADD COLUMN id_flags jsonb;

ALTER TABLE access_request ADD COLUMN check_method text
  CHECK (check_method IN ('record_match', 'callback', 'in_person', 'other', 'vendor'));
ALTER TABLE access_request ADD COLUMN check_matched jsonb;
ALTER TABLE access_request ADD COLUMN check_note text;
