-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P66: staff change a person's email or mobile number on the People view. The portal signs
-- people in by that contact, so the new one is stored only once the link sent to it is opened:
-- its own kind of secret, which changes the contact and signs nobody in.

ALTER TABLE sign_in_challenge DROP CONSTRAINT sign_in_challenge_kind_check;
ALTER TABLE sign_in_challenge ADD CONSTRAINT sign_in_challenge_kind_check
  CHECK (kind IN ('magic_link', 'sms_code', 'request_confirm', 'phone_confirm', 'contact_confirm'));
