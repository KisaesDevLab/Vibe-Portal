-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- QA 2026-11-09: an access request records which contact received and returned the code. Only
-- that contact is used when staff approve it (the other one was never proved).

ALTER TABLE access_request ADD COLUMN confirmed_contact text;
ALTER TABLE access_request ADD CONSTRAINT access_request_confirmed_contact
  CHECK ((confirmed_at IS NULL) = (confirmed_contact IS NULL));
