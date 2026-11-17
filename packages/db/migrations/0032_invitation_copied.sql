-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P101: an invitation whose link a staff member copied instead of having it sent. The link
-- did not go to the invitation's email or number, so opening it does not show that the contact
-- is the holder's: such an invitation never opens an account that already exists, and never
-- takes other invitations with it (portal/invitations.ts).

ALTER TABLE portal_invitation ADD COLUMN copied boolean NOT NULL DEFAULT false;
