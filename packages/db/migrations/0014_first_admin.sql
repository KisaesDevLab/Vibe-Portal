-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P52: the first staff account without a command. The portal emails the first admin (set on
-- the appliance, FIRST_ADMIN_EMAIL) a setup link when it starts; this keeps the last such email:
-- { email, at, ok }, so a restart does not send again but a changed address or a failed send does.

ALTER TABLE firm ADD COLUMN first_admin_mail jsonb;
