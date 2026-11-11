-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P60: a second, optional logo shown when the device is set to dark mode.

ALTER TABLE firm ADD COLUMN logo_dark bytea;
ALTER TABLE firm ADD COLUMN logo_dark_type text;
