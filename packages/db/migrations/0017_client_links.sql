-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P55: a client's people may send a secure link to files the firm shared with them, to someone
-- outside (a lender, another adviser), when an admin turns it on. Always watermarked, at most
-- 30 days. The firm sees every such link on the client's page and can revoke it.

ALTER TABLE firm ADD COLUMN client_links boolean NOT NULL DEFAULT false;
ALTER TABLE file_share ADD COLUMN sent_by_identity_id uuid REFERENCES portal_identity (id);
CREATE INDEX file_share_sent_by_idx ON file_share (sent_by_identity_id)
  WHERE sent_by_identity_id IS NOT NULL;
