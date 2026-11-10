# Questions

| # | Date | Question | Assumption (until answered) | Answer |
|---|---|---|---|---|
| P1 | 2026-11-09 | Upload size limit and allowed types | 100 MB per file; PDF, images, Office, CSV, text | Owner 2026-11-09: the firm sets it (appliance admin), default 100 MB. Types as assumed |
| P2 | 2026-11-09 | Where client uploads land in the cabinet | A `_Portal inbox` folder in the cabinet, registered as a shared Intake inbox | Owner 2026-11-09: as assumed |
| P3 | 2026-11-09 | How a client upload is matched to its client in Intake | Saved as `<Client name>_<Client ID>_<original name>` so Intake's normal reading finds the client | Owner 2026-11-09: as assumed |
| P4 | 2026-11-09 | Notify the client when a file is shared? | Yes, by the user's chosen channel (email and/or SMS) | Owner 2026-11-09: yes; default email, each user picks email, SMS, both or none |
| P5 | 2026-11-09 | Staff screens | None on the web; everything staff do is in Vibe Files | Owner 2026-11-09: add a small staff web page (D13) |
| P6 | 2026-11-09 | Encrypt files at rest on the appliance | Yes, TB's firm master key envelope | Owner 2026-11-09: as assumed |
| P7 | 2026-11-09 | Address when TB is also installed | Own path | Owner 2026-11-09: own hostname (e.g. files.yourfirm.com) through its own Cloudflare Tunnel hostname |
| P8 | 2026-11-09 | Are fetched client uploads kept on the portal? | Kept 30 days after fetch, then purged; the client still sees "Received by the firm" | Owner 2026-11-09: as assumed |
| P9 | 2026-11-09 | How staff sign in to the staff page | Vibe Auth single sign-on when the appliance has it; otherwise staff accounts made in the appliance admin screen, password + authenticator code (TB's TOTP) | Owner 2026-11-09: as assumed |
| P10 | 2026-11-09 | Can the staff page download client uploads without them leaving the Intake queue? | Yes: downloading on the page is logged, but only Vibe Files' fetch marks an upload fetched, so it still reaches Intake | Owner 2026-11-09: as assumed |
| P11 | 2026-11-09 | How long a client stays signed in on a device | 30 days with "remember this device" | Owner 2026-11-09: 7 days |
| P12 | 2026-11-09 | Idle sign-out within that | 30 minutes idle unless "Keep me signed in on this device" | Owner 2026-11-09: as assumed |
| P13 | 2026-11-09 | How long a portal invitation is valid | 7 days; Vibe Files offers Resend | Owner 2026-11-09: as assumed |
| P14 | 2026-11-09 | Firm key: one per PC or one per firm | One per PC | Owner 2026-11-09: **one for the firm**, pasted on every PC like the B2 sync key. `firm_keys` keeps old rows so a key can be rotated (new key, then revoke the old) |
| P15 | 2026-11-09 | Which PC did it, with one shared key | Vibe Files sends PC name + Windows user on each call; stored in the event (shows who in practice, not proof) | Owner 2026-11-09: as assumed |
| P16 | 2026-11-09 | Must "Request access" confirm email/phone first | Yes, by a code; only confirmed requests reach staff | Owner 2026-11-09: as assumed |
| P17 | 2026-11-09 | Can a client user see the other users of the same client | No | Owner 2026-11-09: as assumed |
| P18 | 2026-11-09 | Messages when staff share several files at once | One message per batch: shares to the same person within 5 minutes gathered into one | Owner 2026-11-09: as assumed |
| P19 | 2026-11-09 | How the client's Files page is organised | Newest shared first, a year filter (tax year sent by Vibe Files) and a search box | Owner 2026-11-09: as assumed |
| P20 | 2026-11-09 | What the client sees after "Update on portal" | Same row, content replaced, marked "Updated <date>" and new again; old content not kept | Owner 2026-11-09: as assumed |
| P21 | 2026-11-09 | Do staff see who opened a shared file | Yes: the Share window shows "Opened <date>" / "Not opened yet" per user; every view and download in the audit trail | Owner 2026-11-09: as assumed |
| P22 | 2026-11-09 | Which files open in the browser | PDF (PDF.js viewer) and JPG/PNG; others download | Owner 2026-11-09: as assumed |
| P23 | 2026-11-09 | Largest file staff can share | The firm's upload limit (default 100 MB, Cloudflare free-plan cap) | Owner 2026-11-09: as assumed |
| P24 | 2026-11-09 | Can a client hide a shared file from their own list | No; only staff decide what is on the portal | Owner 2026-11-09: as assumed |
| P25 | 2026-11-09 | Which client address rate limits count by | Cloudflare's CF-Connecting-IP behind the tunnel (`TRUST_CF_CONNECTING_IP`, default on), else the socket; never the client-written first entry of X-Forwarded-For (QA 2026-11-09) | |
| P26 | 2026-11-09 | Does opening a sign-in link sign the person in at once | No: the page asks them to press **Sign in**, so email security scanners that open links cannot use up the one-time link (QA 2026-11-09) | |
| P27 | 2026-11-09 | Which contact is used when an invitation or request carries both email and phone | Only the one the link or code went to (email when given). The other never matches an existing person; from an invitation (staff typed it) it is stored only if no one else has it; from a request it is never stored (QA 2026-11-09) | |
| P28 | 2026-11-09 | Where the key that unlocks stored files lives | `DATA_DIR/.firm-key.seal` on the appliance (TB's sealed-on-disk mode); the database holds the master key wrapped by it. Losing the file loses every stored file, so backups must include it (Phase 5); a backup holding both can read the files | |
| P29 | 2026-11-09 | Which file types clients may upload | PDF; JPG/PNG/HEIC/TIFF; Word/Excel; CSV; TXT, checked by content as well as name; nothing else | Owner 2026-11-09: as assumed |
| P30 | 2026-11-09 | What a client adds with an upload | An optional note (no year picker) | Owner 2026-11-09: optional note only |
| P31 | 2026-11-09 | Are staff told of new uploads beyond Intake | No; uploads appear in Intake's Portal inbox within the fetch interval | Owner 2026-11-09: as assumed |
| P32 | 2026-11-09 | Can a client delete their own upload | Only before Vibe Files fetches it; afterwards it shows "Received by the firm" | Owner 2026-11-09: as assumed |
| P33 | 2026-11-09 | iPhone HEIC photos | Kept as uploaded | Owner 2026-11-09: **converted to JPG** on the portal before Vibe Files fetches them |
| P34 | 2026-11-09 | How many files per upload | Up to 20 per batch, each within the firm's size limit; one note covers the batch | Owner 2026-11-09: as assumed |
| P35 | 2026-11-09 | HEIC conversion library licence | `heic-convert` (ISC) uses `libheif-js` (LGPL-3.0), unmodified, as Vibe Time & Billing already does; same licence position as TB | |
| P36 | 2026-11-09 | Where portal settings live, now that the appliance admin screen is gone (vibe-installer 02c18f2) | Staff web page | Owner 2026-11-09: the staff web page (Phase 6b) gets Settings: firm name/logo, upload limit, firm key create/revoke, staff accounts. The first staff account comes from a one-time setup link printed at install. Until 6b, the `firm-key` command |
| P37 | 2026-11-09 | Own hostname (P7) on the appliance | Extend the installer's Caddy | Owner 2026-11-09: `vibe install portal --host files.firm.com` adds a second site; the firm adds that hostname to the same Cloudflare tunnel; other apps untouched |
| P38 | 2026-11-09 | Email and SMS services | SMTP + Twilio, as Vibe Connect | Owner 2026-11-09: as assumed; set in /etc/vibe/portal/.env |
| P39 | 2026-11-09 | Licence check | Like the other apps | Owner 2026-11-09: **none**; free with Vibe Files |
| P40 | 2026-11-09 | Container image | Public GHCR image, private source | Owner 2026-11-09: as assumed; built and published on version tags (I ask before tagging) |
| P41 | 2026-11-09 | Working in vibe-installer | Branch `feat/portal-app`, leaving the untracked admin-config addendum alone | Owner 2026-11-09: as assumed |
