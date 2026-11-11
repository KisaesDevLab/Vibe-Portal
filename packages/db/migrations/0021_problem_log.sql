-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P64: the server's warnings and errors, for the staff page's Log (admins), so a problem can be
-- read without the appliance's container logs. Kept 30 days. No key, password or file content
-- is ever written here.

CREATE TABLE problem_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL,
  msg text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX problem_log_at ON problem_log (at);
