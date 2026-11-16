-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P90: the documents Vibe Files sent to its B2 bucket, by client, as a list for the staff page:
-- where each is in the client's folder, its size and tax year. Names only: the portal holds no
-- content of them and cannot read the bucket. Vibe Files replaces a client's list when it
-- changed; a list from a PC that has seen less of the bucket than the one kept is ignored.
-- The lists are not in the database copies sent to the bucket (files/snapshot.ts): Vibe Files
-- sends them again.

ALTER TABLE clients
  -- The client's manifest segment in the bucket that the list was made from.
  ADD COLUMN cabinet_rev bigint,
  -- How much of the bucket the PC that sent it had seen (the manifest's revision).
  ADD COLUMN cabinet_head_rev bigint,
  -- Vibe Files' own mark of the list's content: the same mark means nothing changed.
  ADD COLUMN cabinet_hash text,
  ADD COLUMN cabinet_listed_at timestamptz,
  -- The PC and Windows user that sent the list kept (two PCs at the same segment).
  ADD COLUMN cabinet_by text,
  -- How many documents the list has, for the client list (not counted at every reading).
  ADD COLUMN cabinet_count integer NOT NULL DEFAULT 0;

CREATE TABLE cabinet_file (
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  -- Vibe Files' document id: `files.vf_document_id` of the same document once it is shared.
  doc_id text NOT NULL,
  -- Below the client's folder, with the file name, `/` between folders.
  path text NOT NULL,
  size bigint NOT NULL,
  tax_year smallint,
  PRIMARY KEY (client_id, doc_id)
);
