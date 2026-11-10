-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P56: a client sending files can tell a staff member, picked from those the firm allows
-- (Settings > Staff, "Clients may notify"). One email per batch.

ALTER TABLE staff_users ADD COLUMN notify_uploads boolean NOT NULL DEFAULT false;

CREATE TABLE upload_notice (
  batch_id    uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES portal_identity (id),
  client_id   uuid NOT NULL REFERENCES clients (id),
  staff_id    uuid NOT NULL REFERENCES staff_users (id),
  sent_at     timestamptz NOT NULL DEFAULT now()
);
