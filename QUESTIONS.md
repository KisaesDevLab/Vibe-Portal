# Questions

| # | Date | Question | Assumption (until answered) | Answer |
|---|---|---|---|---|
| P1 | 2026-11-09 | Upload size limit and allowed types | 100 MB per file; PDF, images, Office, CSV, text | |
| P2 | 2026-11-09 | Where client uploads land in the cabinet | A `_Portal inbox` folder in the cabinet, registered as a shared Intake inbox | |
| P3 | 2026-11-09 | How a client upload is matched to its client in Intake | Saved as `<Client name>_<Client ID>_<original name>` so Intake's normal reading finds the client | |
| P4 | 2026-11-09 | Notify the client when a file is shared? | Yes, by the user's chosen channel (email and/or SMS) | |
| P5 | 2026-11-09 | Staff screens | None on the web; everything staff do is in Vibe Files | |
| P6 | 2026-11-09 | Encrypt files at rest on the appliance | Yes, TB's firm master key envelope | |
| P7 | 2026-11-09 | Path when TB is also installed | Vibe Portal at `/files-portal` or its own hostname; TB keeps `/portal` | |
| P8 | 2026-11-09 | Are fetched client uploads kept on the portal? | Kept 30 days after fetch, then purged; the client still sees the upload in "Your uploads" with "Received by the firm" | |
