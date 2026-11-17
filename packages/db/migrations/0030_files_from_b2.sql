-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P94: a file staff added to the portal from Vibe Files' part of the B2 bucket (P91) follows
-- the bucket: when Vibe Files pushes a changed version of the document, the portal replaces
-- its copy by itself. Only these files do; one shared from Vibe Files is replaced by Vibe
-- Files, when someone there says so.

ALTER TABLE files ADD COLUMN from_b2 boolean NOT NULL DEFAULT false;

-- The ones added from B2 before this (0.3.16): History says which.
UPDATE files SET from_b2 = true
 WHERE id IN (SELECT file_id FROM events
               WHERE kind = 'file_added' AND file_id IS NOT NULL AND detail->>'from' = 'b2');
