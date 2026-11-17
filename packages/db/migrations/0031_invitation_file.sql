-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P98: files chosen for someone who was invited and has not accepted yet. They have no account
-- to show a file to, so the choice is kept with the invitation; when they accept, each becomes
-- a file shown to them (file_visibility), and they find the files at their first sign-in. A
-- new invitation to the same contact (Resend) takes the choices over.

CREATE TABLE invitation_file (
  invitation_id uuid NOT NULL REFERENCES portal_invitation (id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files (id) ON DELETE CASCADE,
  chosen_at timestamptz NOT NULL DEFAULT now(),
  chosen_by text NOT NULL DEFAULT '',
  PRIMARY KEY (invitation_id, file_id)
);
CREATE INDEX invitation_file_file ON invitation_file (file_id);
