-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- Phase 7: Cloudflare (Free and Pro plans) refuses a request body over 100 MB (100,000,000
-- bytes), and 100 MiB is more than that: a file near the old limit would pass the portal's
-- check and then break at Cloudflare. The limit is now at most 95 MiB (99,614,720 bytes).

ALTER TABLE firm ALTER COLUMN upload_limit_bytes SET DEFAULT 99614720;
UPDATE firm SET upload_limit_bytes = 99614720 WHERE upload_limit_bytes > 99614720;
