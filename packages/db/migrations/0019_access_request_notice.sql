-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P59: staff an admin ticks on Settings > Staff ("Email new access requests") are emailed when
-- someone confirms a request for access. Only staff who see every client get it (only they see
-- and approve requests).

ALTER TABLE staff_users ADD COLUMN notify_access_requests boolean NOT NULL DEFAULT false;
