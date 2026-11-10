# Vibe Portal — Build Plan

A client file portal for firms that run **Vibe Files** but not **Vibe Practice Management**
(Vibe Time & Billing). Staff share files with clients from Vibe Files; clients sign in to the
portal to download them and to upload documents, which come back into Vibe Files' Intake.

Owner decisions, 2026-11-09 (Q&A):

| # | Topic | Decision |
|---|---|---|
| D1 | Codebase | A trimmed copy of the Vibe Time & Billing (TB) client portal: sign-in, Files, Switch entity. No billing, letters, requests, messaging, tax returns, appointments. |
| D2 | Hosting | A Docker app installed by the Vibe Appliance (`vibe-installer/apps/portal`), like `connect` and `tb`. |
| D3 | Internet access | The appliance's existing Cloudflare Tunnel mode (`cf-tunnel`). |
| D4 | Client sign-in | Client accounts, signed in as in TB's portal: magic link by email or 6-digit SMS code; new devices are challenged. Email and SMS use the appliance's Email & SMS settings. |
| D5 | Accounts | Staff invite from Vibe Files, **and** clients may request access themselves; staff approve and link the request to a client. A client (entity) can have several portal users (spouse, bookkeeper); one user can belong to several clients (Switch entity). |
| D6 | Jobs | Send files to clients; receive files from clients. Nothing else in v1. |
| D7 | Vibe Files ↔ portal | The portal's HTTPS API, authenticated with a firm key pasted into Vibe Files Setup (like the B2 sync key). |
| D8 | Sending | A **Share** button in Vibe Files' right-hand file pane opens a window listing the client's portal users, with a switch per user to show or hide the file. |
| D9 | Lifetime | A shared file stays on the portal until staff remove it (hidden from every user, or **Remove from portal**). |
| D10 | Uploads | Client uploads are fetched by Vibe Files into a Portal inbox and filed through Intake like scans. |
| D11 | With full TB | The portals run side by side; the firm decides per client which one to use. No migration in v1. |
| D12 | Not TB "files only" | Considered running TB itself with its portal feature switches (`@vibe/core/portal-features`) set to Documents only. Rejected: Vibe Portal stays a separate, smaller app (no worker, Redis or TB's full staff app) with its own license and releases; copied TB code is tracked in `VENDORED.md`. |
| D13 | Staff web page | A small staff page in the portal besides Vibe Files (Q&A 2026-11-09, P5): invites, client users, access requests, client uploads, hide/remove shared files. Sharing new files stays in Vibe Files. Sending a file already on the portal to someone outside the client, by a secure link, is done on the staff page (P49). |

---

## 1. Architecture

```
 Client browser ──HTTPS──▶ Cloudflare Tunnel ──▶ appliance Caddy ──▶ vibe-portal (nginx + API)
                                                                          │
 Office PC: Vibe Files ──HTTPS (firm key)──────────────────────────────────┘
          │                                                          Postgres (portal db)
          └── cabinet share (client folders, Intake inboxes)         /data/portal (file blobs)
```

- **Staff work mainly in Vibe Files**, through the firm API. A **small staff web page** (D13) covers
  the jobs that need no cabinet access, for staff away from a Vibe Files PC: invites, client users,
  access requests, client uploads, and hiding or removing files already shared. Sharing a *new*
  file is only done from Vibe Files, because only Vibe Files reaches the cabinet. A file already
  on the portal can be sent from the staff page to **someone outside the client** (a lender, a
  lawyer) by a secure link, as Time & Billing's secure share (P49).
- **The cabinet is the source of truth.** The portal holds a *copy* of each shared file. The
  original never leaves the cabinet and is never changed by the portal.
- **Only staff decide visibility.** New files come only from Vibe Files; the staff page can hide or
  remove them. The portal never decides visibility on its own.
- **Which client is which:** the portal keys clients by the Vibe Files client identity (its stable
  client UUID) and stores the display name and client ID for the client's screens.

### Stack (from TB, trimmed)

| Layer | Choice |
|---|---|
| Client SPA | React 18 + Vite + TypeScript + Tailwind, `@vibe/ui` (copied from TB `apps/portal`) |
| API | Node 24 + Express + Drizzle + Zod (copied from TB `apps/api` portal/auth modules) |
| Database | Postgres 16 (own database, own container, as `connect` does) |
| Sessions | Postgres-backed (no Redis, to keep the app small) |
| File storage | Local volume `/data/portal`, each blob encrypted at rest with the firm master key (TB `@vibe/crypto` envelope: XChaCha20-Poly1305, per-file DEK) |
| Email / SMS | Appliance Email & SMS settings (`EMAIL_PROVIDER`, `SMS_PROVIDER`) |
| License | PolyForm Small Business 1.0.0, as TB |

### What is copied from TB and what is not

| From TB | Keep | Notes |
|---|---|---|
| `apps/portal` pages `Login`, `AcceptInvitation`, `RequestAccess`, `Files`, `FilePreview`, `Switch`, `Profile`, `NotificationPrefs`, `Help` | yes | Strip billing, pay-to-unlock banner, requests, messaging links |
| `apps/portal` everything else (Invoices, Letters, Proposal, Retainers, TaxReturns, Messages, Appointments, …) | no | |
| `apps/api/src/auth/portal-*`, `step-up*`, `session-*`, `cookies`, `request-ip` | yes | Client identities |
| `apps/api/src/auth/password`, `totp-secret`, `sso/vibe-auth-adapter` | yes | Staff sign-in for the staff page (D13, P9); no RBAC: every staff user can do everything on the page |
| `apps/api/src/portal-invites/grant.ts`, `portal-access-requests` | yes | Called from the firm API instead of the staff app |
| `apps/api/src/portal/files.ts`, `file-shares.ts` | partly | Files list/download kept; client-made share links (TB CP11) **out** of v1. Staff-made links to someone outside the client: `firm/shares.ts`, `portal/shared.ts` (P49), written for Vibe Portal |
| `apps/api/src/files/visibility.ts` | rework | TB shows a file to the whole client; Vibe Portal shows it **per user** (D8) |
| `packages/crypto`, `packages/ui`, `packages/types` | yes | |
| `packages/storage` (B2) | no | Local volume only in v1 |

Copying, not sharing a package, is deliberate (D1, D11): the two products then release on their own.
Each copied file keeps a header line `// Copied from Vibe-Time-Billing <path> @ <commit>` and the
copy log lives in `VENDORED.md`, as Vibe Files does for Filer.

---

## 2. Data model

| Table | Purpose |
|---|---|
| `firm` | One row. Name, branding (logo, colour), portal URL, firm key hash(es) |
| `firm_keys` | `id`, `label`, `key_hash`, `created_at`, `last_used_at`, `revoked_at`. One key for the firm, pasted on every PC (P14); old rows stay so a key can be rotated. Each call also sends the PC name and Windows user, kept in `events` (P15) |
| `clients` | `id` (Vibe Files client UUID), `client_code` (the firm's client ID), `display_name`, `active` |
| `portal_identity` | A person: `id`, `email`, `phone`, `name`, `status` |
| `client_access` | Identity ↔ client: `identity_id`, `client_id`, `role_label` (e.g. "Spouse"), `active`, `invited_by` |
| `portal_invitation` | Pending invites (token hash, expiry), as TB |
| `access_request` | Self sign-up: name, email, phone, "which business / person", note, `status` (pending / approved / denied), `client_id` once approved |
| `files` | `id`, `client_id`, `vf_document_id` (Vibe Files document identity), `name`, `size`, `sha256`, `blob_key`, `dek_wrapped`, `shared_at`, `shared_by`, `removed_at` |
| `file_visibility` | `file_id`, `identity_id`, `visible`, `changed_at`, `changed_by` — one row per user per file |
| `uploads` | `id`, `client_id`, `identity_id`, `name`, `size`, `sha256`, `blob_key`, `dek_wrapped`, `note`, `uploaded_at`, `fetched_at`, `fetched_by`, `purged_at` |
| `events` | Append-only: share, unshare, remove, view, download, upload, fetch, invite, approve, sign-in. Exposed to Vibe Files for its audit trail |
| `sessions` | Client sessions (Postgres) |
| `file_share`, `file_share_item`, `file_share_code`, `file_share_grant`, `file_share_mark` | Secure links to someone outside the client (P49): the link (secret hash, recipient, view only or download, watermark, expiry, revoked, wrong tries, opens), its files, the emailed 6-digit codes, the browsers that gave one (30 minutes), and the watermarked copies kept for the day (encrypted; removed with the file, the link, or the day) |

---

## 3. Firm API (used by Vibe Files)

All under `/api/firm/v1`, `Authorization: Bearer <firm key>`, JSON, Zod-validated, every write
appends to `events`. Rate-limited per key.

| Method | Path | Does |
|---|---|---|
| GET | `/status` | Portal version, firm name, URL; Vibe Files' **Test** button |
| PUT | `/clients/:id` | Create or update a client (code, name). Called on first share/invite and when a client is renamed |
| GET | `/clients/:id/users` | The client's portal users with status (invited / active / disabled) |
| POST | `/clients/:id/invites` | Invite by email and/or phone, with a role label |
| PATCH | `/clients/:id/users/:identityId` | Disable / enable a user's access to this client |
| GET | `/access-requests?status=pending` | Self sign-up requests |
| POST | `/access-requests/:id/approve` | Body: `client_id`; links and notifies |
| POST | `/access-requests/:id/deny` | |
| POST | `/files` | Upload a file for a client (streamed, with `sha256`); returns `file_id`. Same `vf_document_id` + same `sha256` → returns the existing file |
| PUT | `/files/:id/content` | Replace the content with a newer version (the file changed in the cabinet) |
| PUT | `/files/:id/visibility` | Body: `{ identityId: visible }` for each user; notify users who just gained it |
| DELETE | `/files/:id` | Remove from portal (blob deleted, row kept with `removed_at`) |
| GET | `/files?client_id=…` / `?vf_document_id=…` | What is on the portal, and for whom |
| GET | `/uploads?unfetched=1` | Client uploads waiting for the firm |
| GET | `/uploads/:id/content` | Download one |
| POST | `/uploads/:id/fetched` | Marks it fetched (by which PC). Only the first caller wins; others get 409 |
| GET | `/events?since=…` | For Vibe Files' audit trail |

## 4. Client side (portal web)

- **Sign in**: email magic link or SMS code (TB). New device → second factor. Invitation link → set
  name, confirm email/phone.
- **Request access** (public): name, email, phone, "who you are a client as", note. Shows "The firm
  will confirm your access."
- **Files**: files visible to *this user* for the active client, newest first, with date shared.
  Preview (PDF.js; images inline; others download). Download. "New" badge until first opened.
- **Upload**: drag-and-drop or choose files; optional note; progress; size limit set by the firm (default 100 MB per file; Cloudflare's free plan caps a request at 100 MB);
  allowed: PDF, JPG/PNG/HEIC/TIFF, Office (docx, xlsx, csv), txt. List of "Your uploads" with date
  and "Received by the firm" once fetched.
- **Switch entity**: when the user has several clients.
- **Profile / notifications**: email and/or SMS when a file is shared.
- Branding: firm name, logo and colour from `firm`.

## 5. Vibe Files side

| Where | What |
|---|---|
| **Setup → Portal** (admin password) | Portal URL, firm key, **Test**. Off by default; with no key, no portal UI shows anywhere |
| **File pane → Share** | Button in the right-hand file pane (D8). Window: the client's portal users, each with a show/hide switch; **Invite someone…**; **Remove from portal**. Shows "Shared Nov 9 by KK", and "Changed since shared — **Update on portal**" when the cabinet file's hash differs. Several selected files → the same window applies to all |
| **Browse** | A small portal mark on files that are on the portal; tooltip lists who sees them |
| **Client → Portal users…** | Right-click a client: users, invite, disable |
| **Portal requests** | A list of pending self sign-ups (badge count) with **Link to client…** / **Deny** |
| **Portal inbox** | A Vibe Files-managed folder in the cabinet (`_Portal inbox`), registered as a shared inbox. A fetch timer (default 5 min, one PC wins each upload via `/fetched`) saves each upload as `<Client name>_<Client ID>_<original name>` so Intake's existing reading picks the client; the uploader and note go in the Intake row's hover |
| **Audit trail** | Portal events (share, unshare, view, download, upload) appear on the document and client audit views |
| **Help** | `portal.md`; mention in `intake.md` and `browse.md` |

Vibe Files code goes in a new crate `vf-portal` (HTTP client, types), plus UI in `vf-app` and the
Intake inbox registration through Filer's existing shared-inbox setting.

## 6. Appliance packaging (vibe-installer)

- `apps/portal/` with `docker-compose.yml`, `docker-compose.grouped.yml`, `env.template`,
  `caddy.fragment` (its own hostname, QUESTIONS P7; root in single-app mode), `healthcheck.sh`, as
  `apps/connect`.
- `vibe install portal`; appears in Vibe Admin's app list.
- Admin config fields: firm name, logo, colour, portal URL; **Create firm key** (shown once) and
  revoke; upload size limit.
- Backups: Vibe Vault discovers the portal's Postgres and `/data/portal` volume.
- With TB also installed: its own hostname (QUESTIONS P7), no shared state
  (D11).

---

## 7. Phases

Each phase ends with its tests green and a ship gate.

### Phase 1 — Repo and skeleton
- [x] pnpm workspace: `apps/api`, `apps/portal`, `packages/{db,crypto,ui,types}`
- [x] Copy TB packages and portal shell; `VENDORED.md`; PolyForm headers
- [x] Postgres schema + migrations (§2); Docker compose for dev
- [x] `GET /health`
- **Gate:** `pnpm gate` passes; dev stack starts; empty portal page loads

### Phase 2 — Client sign-in and accounts
- [x] Portal identities, magic link + SMS code, sessions (TB's flow, Postgres-backed). No separate
  new-device challenge: every sign-in already needs a link or code sent to the person
- [x] Invitations and accept flow; public access request
- [x] Sign in by text with a number added later (P50): a person signed in by email adds a mobile
  number, stored only after a code texted to it (`phone_confirm`, never a sign-in code), or
  removes it; the invitation offers the number staff typed beside the email the same way
- [x] Firm key auth, key table, rate limits; `/status`, `/clients`, invites, users, access requests
- **Gate:** invite → accept → sign in → sign out, by email and by SMS (mock providers); request →
  approve → sign in; revoked firm key refused

### Phase 3 — Files to clients
- [x] `/files` upload (streamed, hashed, encrypted at rest), content replace, per-user visibility,
  delete
- [x] Client Files page, preview, download, "New" badge; notifications on share (gathered, P18)
- [x] Events for every action
- **Gate:** a file shown to user A only is listed for A and returns 404 for B (API and UI);
  removed file is gone from disk and listing; tampered blob fails to decrypt

### Phase 4 — Files from clients
- [x] Client upload page, limits, types (by content, P29), progress; "Your uploads"; HEIC to JPG
  (P33); remove before fetch (P32); batches of 20 (P34)
- [x] `/uploads` list, content, `fetched` (first wins); purge 30 days after fetch (P8)
- **Gate:** two concurrent fetchers → one 200, one 409; over-size and wrong-type uploads refused

### Phase 5 — Appliance app
- [x] Container image (API serves the built portal; strict CSP), CI and tag-release workflows
  publishing ghcr.io/kisaesdevlab/vibe-portal (P40)
- [x] `vibe-installer/apps/portal` (branch `feat/portal-app`): own-hostname Caddy site (P37),
  `vibe install portal --host`, SMTP/Twilio settings, `vibe portal key`; settings move to the
  staff page (P36, Phase 6b)
- [x] Real email (SMTP) and SMS (Twilio) from /etc/vibe/portal/.env (P38). The console notifier logs
  sign-in links and codes, so the API must refuse it when `NODE_ENV=production`
- [ ] Publish the first image (tag v0.1.0; set the GHCR package public, P40)
- [ ] Cloudflare Tunnel path verified; Vibe Vault discovery. Backups must include
  `DATA_DIR/.firm-key.seal`: without it no stored file can be read (QUESTIONS P28)
- **Gate:** clean install on the appliance test VM, reached over the tunnel from a phone

### Phase 6 — Vibe Files integration
- [x] `vf-portal` crate; Setup → Portal with Test (Admin › Portal in Vibe Files)
- [x] Share window in the file pane; portal mark in Browse; Portal users; Portal requests
- [x] Portal inbox + fetch timer → Intake
- [x] Audit trail (Vibe Files' own portal actions; client events stay on the portal, P43); help pages
- Gate checked by Vibe Files' `scripts/portal-e2e.sh` against this API (two PCs fetching at once
  included)
- **Gate:** from Vibe Files, invite a client, share a file to one of two users, client downloads,
  client uploads, the upload appears in Intake with the right client; all of it in the audit trail

### Phase 6b — Staff web page (D13)
- [x] Staff sign-in (P9: local accounts, password + authenticator; Vibe Auth later, P44); staff
  accounts and the other settings on the staff page itself, the first from
  `vibe portal setup-link` (P36)
- [x] Pages: Clients & users (invite, disable), Access requests (approve → client, deny), Uploads
  (list, download, mark fetched only through Vibe Files), Shared files (who sees each; hide; remove)
- [x] Every action in `events` with the staff user's name, shown on the History page (P43)
- [x] Admins and per-client access (P48): admins alone use Settings; an admin can limit a staff
  member to some clients (`staff_users.admin`, `all_clients`; `staff_client`)
- [x] Secure links to someone outside the client (P49), as Time & Billing's secure share: staff
  pick files already on the portal and a recipient; the recipient opens `/shared` from the email,
  proves the mailbox with a 6-digit code, and views (or also downloads) for 30 minutes at a time
  until the link expires or is revoked. View only, optional PDF watermark, lockout after 15 wrong
  codes, all of it in `events`
- **Gate:** a request approved on the page shows the client as active in Vibe Files' Share window;
  a file removed on the page shows as not on the portal in Vibe Files

### Phase 7 — Hardening
- [x] Security review (auth, firm key handling, upload parsing, path handling, headers/CSP);
  fixes in P45-P46
- [x] Load: 500 clients, 20,000 files (`LOAD=1` test); 95 MB uploads stream (P46). Over the real
  tunnel: owner's check on the appliance
- [x] Docs: firm setup guide (`docs/firm-setup.md`)

---

## 8. Out of scope (v1)

Billing and payments, engagement letters and e-signature, document request lists, messaging,
client-made share links, expiry of shared files (D9), migration into TB's portal (D11), B2/S3
storage, sharing new files from the staff web page.
