-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- Phase 6b QA: a first-account link stays a first-account link after it names the account it
-- made (so it can be checked again when finished), and each authenticator code is used once
-- (RFC 6238 §5.2).

ALTER TABLE staff_setup_token ADD COLUMN first boolean NOT NULL DEFAULT false;
UPDATE staff_setup_token SET first = true WHERE staff_id IS NULL;
-- The last 30-second step a code was accepted for.
ALTER TABLE staff_users ADD COLUMN totp_last_step bigint;
