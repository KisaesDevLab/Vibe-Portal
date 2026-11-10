-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P51 follow-ups. Each installation gets an id: the portal writes it into the B2 bucket it uses,
-- and refuses a bucket marked by another installation (a second portal, or a new one with an
-- empty database, must never sweep away files it does not know of). storage_note keeps what the
-- daily sweep for leftover stored files found.

ALTER TABLE firm
  ADD COLUMN install_id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- { sweptAt, removed, refused: { at, count, total } | null, otherBucket }
  ADD COLUMN storage_note jsonb;
