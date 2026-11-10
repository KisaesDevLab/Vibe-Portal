-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P48: staff access. An admin uses Settings (the firm, portal keys, staff accounts); other staff
-- do the daily work. Every staff member sees every client unless an admin limits them to some
-- (the exception, not the rule). Accounts made before this could do everything, so they are
-- admins.

ALTER TABLE staff_users ADD COLUMN admin boolean NOT NULL DEFAULT false;
UPDATE staff_users SET admin = true;
ALTER TABLE staff_users ADD COLUMN all_clients boolean NOT NULL DEFAULT true;

-- The clients a limited staff member sees (used only while all_clients is false).
CREATE TABLE staff_client (
  staff_id uuid NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, client_id)
);
