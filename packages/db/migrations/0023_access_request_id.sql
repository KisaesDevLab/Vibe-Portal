-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P67: a photo ID (driver's license, state ID or passport) with every access request, shown to
-- the staff who decide it. Stored encrypted like an upload.
--
-- On approval, a PDF of the request and its photo ID goes to Vibe Files' Portal inbox as an
-- upload of the first client (access_request_id names the request). Vibe Files fetches an upload
-- only once its checksum matches: 7 days after that the portal deletes the photo ID and its own
-- copy of the PDF. A denied request's photo ID is deleted 30 days after the decision, and an
-- unconfirmed request's with the request.

ALTER TABLE access_request ADD COLUMN id_blob_key text;
ALTER TABLE access_request ADD COLUMN id_dek_wrapped bytea;
ALTER TABLE access_request ADD COLUMN id_content_type text;
ALTER TABLE access_request ADD COLUMN id_size bigint;
ALTER TABLE access_request ADD COLUMN id_removed_at timestamptz;

ALTER TABLE uploads ADD COLUMN access_request_id uuid REFERENCES access_request (id);
