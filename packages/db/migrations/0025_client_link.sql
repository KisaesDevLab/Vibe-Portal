-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P76: each client can have a link from another service (its own URL), with a short message and
-- a button, shown at the top of the client's portal. Set per client on the staff page, or many
-- at once from a CSV; a link can be changed or removed at any time.

CREATE TABLE client_link (
  client_id uuid PRIMARY KEY REFERENCES clients (id) ON DELETE CASCADE,
  url text NOT NULL,
  message text NOT NULL,
  button text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);
