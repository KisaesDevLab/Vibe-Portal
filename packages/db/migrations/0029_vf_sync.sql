-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P91: staff can put a document that is in Vibe Files' part of the B2 bucket on the portal from
-- the staff page. Vibe Files encrypts what it sends to B2, so the portal needs its firm sync
-- key: an admin enters the sync passphrase once on Settings > Storage, and the key it opens is
-- kept here wrapped by the portal's own key (as the B2 application key is), with the id of the
-- cabinet it belongs to. The passphrase itself is not kept.

ALTER TABLE firm ADD COLUMN vf_sync_enc bytea;
