-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P50: a person signed in by email adds a mobile number to sign in by text. The number is
-- stored only after a code texted to it is typed back, as its own kind of secret: a sign-in
-- code (sms_code) signs in whoever receives it, so a mistyped number must never get one.

ALTER TABLE sign_in_challenge DROP CONSTRAINT sign_in_challenge_kind_check;
ALTER TABLE sign_in_challenge ADD CONSTRAINT sign_in_challenge_kind_check
  CHECK (kind IN ('magic_link', 'sms_code', 'request_confirm', 'phone_confirm'));
