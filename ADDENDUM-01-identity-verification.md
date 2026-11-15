# Addendum 01 — Verifying who is asking for access

Status: layers A and B built 2026-11-14, with the firm's switch (P88). Layer C (Stripe) is not
built. The decisions are P80–P88 in `QUESTIONS.md`. Where what was built differs from the text
below, section 8 says how; section 8 wins.

New scope goes here, not into `BUILD_PLAN.md`.

## 1. Where we are

| Path | What proves the person today |
|---|---|
| Invited by staff | They hold the mailbox or phone staff typed (P13, P27) |
| Request access | They hold the mailbox or phone they typed (P16), and they sent a picture of a photo ID that staff look at (P67) |

What that leaves open for a request:

- A picture of an ID shows the person has a picture, not that the ID is theirs.
- Nothing checks that the ID is current or that its name is the name on the request.
- Staff approving on the web page have no client record to compare with.
- The approval record (P67's PDF) says who approved, not what they checked.

Invited people are not changed by this addendum: staff took the contact from the client record.

## 2. The design: three layers

| Layer | What it adds | Needs | Default |
|---|---|---|---|
| A. ID scan | Front and back from the camera; the back's barcode read into name, date of birth, address and expiry; flags | Portal only | On |
| B. Match to the firm's records | The request compared with the client record in Vibe Files; otherwise staff say how they checked | Portal + Vibe Files | On |
| C. Vendor check | Document and selfie check by Stripe Identity; the portal keeps the result only | Portal + the firm's Stripe account | Off |

### The rule on Approve

| The request | Before **Approve** works |
|---|---|
| Matches the client record (layer B) | Nothing more |
| No match, or approved on the staff web page | Staff choose how they checked (see B2), or the person passed layer C |
| Flagged by layer A (expired, name differs, unreadable) | The flag is shown on the request; staff may still approve, and the flag is in the record |

A firm setting, **Check before approving** (`firm.request_check`: `required` default, `off`),
turns the rule off for firms that do not want it (P83).

## 3. Layer A — ID scan

### A1. Capture (request page)

- Two pictures, **Front** and **Back**, each from the live camera (`packages/ui/camera.ts`:
  `buildScanConstraints`, `pickRearCamera`) with the phone's own camera app as the fallback
  (`<input capture>`), and **Choose a file** last. On a desktop, file choice as now.
- **My ID has no barcode** (a passport, a foreign ID): front only; the request is flagged
  `no_barcode` and falls to the rule above.
- Same limits as P67 and P73 (kinds by content, 15 MB, pixel caps, HEIC to JPEG, EXIF rotation).
- A request is confirmed only with a front, and a back or `no_barcode` (P67's `id_required`).

### A2. Reading the barcode (API)

- Decode PDF417 from the back picture on the appliance. Assumed library: `zxing-wasm` (P80:
  confirm the licence and that it runs under Node 24 with no native build).
- Parse the AAMVA fields:

| Field | AAMVA element | Kept |
|---|---|---|
| Family name, first, middle | `DCS`, `DAC`, `DAD` | Yes |
| Date of birth | `DBB` | Yes |
| Expiry, issue date | `DBA`, `DBD` | Yes |
| Street, city, state, ZIP | `DAG`, `DAI`, `DAJ`, `DAK` | Yes |
| Issuing state or country | `DAJ` / `DCG` | Yes |
| Licence number | `DAQ` | **Never stored or logged** (P81) |

- Flags, worked out once when the back is sent:
  - `expired`: expiry before today.
  - `name_differs`: the request's name and the barcode's share no family name and first name
    (case, accents and punctuation ignored; middle names ignored).
  - `unreadable`: no PDF417 found, or not AAMVA. The person is asked once to retake it; a second
    failure is accepted and flagged.
  - `no_barcode`: from A1.
- Comparing the barcode with the printed front needs OCR, which the portal does not have. Out
  of this addendum (P82); staff see the parsed fields beside the front picture.

A barcode can be made by anyone. Layer A catches a wrong, old or mistyped ID and gives staff
fields to compare; it does not prove the ID is genuine. Layers B and C do that work.

### A3. Storage

`access_request` gains:

| Column | Holds |
|---|---|
| `id_back_blob_key`, `id_back_dek_wrapped`, `id_back_content_type`, `id_back_size` | The back picture, encrypted like the front (P67) |
| `id_scan` (jsonb) | `{ familyName, firstName, middleName, dob, expires, issued, address, issuer }` |
| `id_flags` (text[]) | The flags above |

Keeping follows the front exactly (P67, P73): the back, `id_scan` and `id_flags` are cleared
when the front is (`id_removed_at`). The storage sweep and moves (local, B2) count the back.

### A4. Staff and the record

- Access requests (staff page): front and back side by side, the parsed fields beside them,
  flags as tags in the danger colour. Each look is in History as now.
- `GET /api/{staff,firm}/v1/access-requests`: `idScan`, `idFlags`, `idBack`.
  `GET …/access-requests/:id/id-photo?side=back`.
- `POST /api/portal/access-requests/:id/id-photo?side=front|back` (default `front`, so the
  present page keeps working).
- The approval PDF (P67) adds the back picture, the parsed fields, the flags, and section 4's
  check. The original back is attached like the front.

### Gate A

A request with a test AAMVA back shows its fields on the staff page and in the PDF; an expired
one and a different name are flagged; a picture with no barcode is accepted on the second try
and flagged; the licence number is in no table, event or log line; clearing the front clears
the back and the fields.

## 4. Layer B — Match to the firm's records

### B1. In Vibe Files (the client record is only there)

A Vibe Files client is an ID, a name and the client list's other CSV columns
(`filer-core/src/clients.rs`, `Client.extra`). So:

- **Admin › Portal** gains three optional pickers: which column holds the client's **email**,
  **mobile** and **date of birth**. None chosen: no match is possible and B2 applies.
- **Portal requests**, once staff pick a client, shows one line each:
  - Email: matches the record / differs / not in the record
  - Mobile: the same
  - Date of birth (from `idScan.dob`): the same
  - Name on the ID against the client's name: shown side by side, not scored
- A request **matches** when its confirmed contact (P16) equals the record's email or mobile,
  or the ID's date of birth equals the record's and the name flag is clear (P84).
- The comparison runs in Vibe Files. Nothing from the client record goes to the portal; only
  what matched does (B3).

### B2. When there is no match, and on the staff web page

**Approve** opens **How did you check?**, one choice required:

| Choice | Staff also give |
|---|---|
| Called the number in our records | Who they spoke to |
| Met in person | — |
| Known to me, other | A note (required) |

Texting or emailing the contact on the request is not a choice: that contact is what is being
checked.

### B3. API

`POST /api/{staff,firm}/v1/access-requests/:id/approve` body gains:

```json
{ "check": { "method": "record_match | callback | in_person | other | vendor",
             "matched": ["email", "mobile", "dob"],
             "note": "" } }
```

- With `firm.request_check = required`, an approval without `check` is refused
  (`check_required`). An older Vibe Files sends none, so its **Approve** is refused with a
  message to update or to approve on the staff page (P85).
- `vendor` is accepted only when the request has a passed layer C result.
- `access_request` gains `check_method`, `check_matched` (text[]), `check_note`. The approval
  event and the PDF carry them with the staff member's name.

### Gate B

In Vibe Files, a request whose email is in the client's row approves in one step and the PDF
says "Email matches the client record"; one that matches nothing cannot be approved until a
choice is made; the staff page always asks; an approval with no `check` returns
`check_required`.

## 5. Layer C — Vendor check (optional)

Stripe Identity: the person photographs the ID and takes a selfie on Stripe's page; Stripe
answers verified or not. Stripe's published price is $1.50 a completed check, the first 50
free, billed to the firm's own Stripe account. Check Stripe's current API and prices when
building.

- **Settings › Identity check** (admins): mode `off` (default) / `when no match` / `every
  request`; a restricted Stripe key and the webhook signing secret, kept sealed like the SMTP
  password; **Test**.
- Flow, after the contact is confirmed (P16):
  1. The portal creates a verification session (document, selfie required) and sends the
     person to Stripe's hosted page. A redirect, so the portal's CSP is unchanged.
  2. Stripe calls `POST /api/hooks/stripe-identity` (signature checked; reachable through the
     tunnel). The portal stores the status and, when verified, the name and date of birth.
  3. The person returns to "The firm will confirm your access."
- Mode `every request`: this replaces the portal's own ID pictures (A1). Mode `when no match`:
  staff press **Ask for an identity check** on a request; the person gets a link by the
  confirmed contact.
- `access_request` gains `vendor_status` (`none`, `pending`, `verified`, `failed`),
  `vendor_session_id`, `vendor_name`, `vendor_dob`, `vendor_checked_at`. No pictures and no
  document number are fetched or stored. The session is redacted at Stripe when the portal's
  own ID would have been deleted (P67, P73).
- A verified result counts as layer A's fields for B1's date-of-birth match, and lets staff
  approve with `method: vendor`.
- Still free, no licence check (P39): the firm pays Stripe, not Kisaes.

### Gate C

With Stripe's test mode: a verified session lets staff approve with `vendor`; a failed one
does not; a webhook with a bad signature is refused; mode `off` shows no trace of it anywhere.

## 6. Order of work

1. Layer A (portal only; releases by itself).
2. Layer B portal side (`check` on approve, the staff page's question, the PDF), then Vibe
   Files (column pickers, match lines, the question).
3. Layer C, only once P86 is answered.

## 7. Out of scope

Knowledge questions from credit files; asking for a Social Security number; reading the front
by OCR; matching a face on the appliance; any check of invited people; an enrollment code on
the engagement letter (P87, later).

## 8. As built (2026-11-14)

The owner's answers on 2026-11-14 and what the code showed changed these points.

### The switch (P88)

Two firm settings, on **Settings › Access requests** (admins):

| Setting | Choices | A firm that updates gets |
|---|---|---|
| **ID with a request** (`firm.request_id_mode`) | `none`; `photo`, one picture as P67; `scan`, layer A | `photo` |
| **Check before approving** (`firm.request_check`) | `off`; `required`, the rule of section 2 | `off` |

- The defaults are today's behaviour, not section 2's "On": a Vibe Files from before layer B
  sends no `check`, and `required` refuses it.
- Stripe becomes a fourth choice of the first setting when layer C is built.
- With `none`, a request has no ID. Its approval PDF is still made and filed, and says so.
- The request page reads the first setting from `GET /api/portal/branding` (`requestIdMode`).
  Staff and Vibe Files read the second from `GET …/access-requests` (`requestCheck`):
  Settings is for admins only.

### Layer A

- **Camera.** Nothing in the portal used `packages/ui/camera.ts`. The request page now opens
  `CameraCapture` (one picture, then it closes) for each side on a phone or tablet; on a
  desktop a file is chosen.
- **The back is a picture.** A PDF back is refused (`id_type`): a barcode is not read from one.
- **Reading.** `zxing-wasm` 3.1.6 (MIT; zxing-cpp, Apache-2.0), with `jpeg-js` (BSD-3-Clause)
  and `pngjs` (MIT), under Node 24 with no native build (P80).
  - It runs in a process of its own (`apps/api/src/files/barcode-worker.cjs`), one at a time.
    A worker thread running it once ended the whole server with a V8 fault as it was stopped.
  - zxing-cpp finds a tilted PDF417 but seldom reads it. So a picture that does not read is
    cut to the square around the barcode and read again turned upright, a degree at a time,
    at three sizes, plain and sharpened, for at most 20 seconds.
  - Only text that begins as a licence barcode counts. A soft picture now and then "reads" as
    noise that passes the barcode's own checks.
  - A picture over 50 MP is kept, not decoded, and flagged `unreadable`.
- **How well it reads (measured 2026-11-14).** No real licence was used. The five barcodes on
  the Florida, Georgia and Virginia DMV calibration sheets were made to look like phone
  photos: blurred, darkened, saved as JPEG, turned 0 to 25 degrees, sideways and upside down.

  | Picture | Read | Most memory the reader held |
  |---|---|---|
  | The clean sheets | 5 of 5 | |
  | Camera page, 2560×1440 | 37 of 45 | 217 MB |
  | Camera page, 1280×720 | 32 of 45 | 173 MB |
  | Phone photo, 12 MP | 44 of 90 | 354 MB |
  | Phone photo, 48 MP | 6 of 10 | 870 MB |

  - By sheet: Florida 36 of 38, Georgia 34 of 38, Virginia 49 of 114. Virginia's barcodes
    hold more and are denser.
  - No picture read as the wrong text, and none stopped the reader.
  - A picture that does not read takes up to 20 seconds before the page is answered.
  - These are stand-ins. How real phone photos read is not known until a real licence is
    tried; the blur given to the large photos may be harsher or kinder than a phone's.
  - The camera page reads best, which is why the request page offers it first on a phone.
- **Retake.** `POST …/id-photo?side=back` answers `readable`. The page asks once for another
  picture; the request can also go on with the first.
- **No barcode.** The person ticks **My ID has no barcode**; the confirm call carries
  `noBarcode: true`, and the request is flagged `no_barcode`. Without a back or that tick,
  confirming answers `id_back_required`.
- **Licence number (P81).** The parsed field is never kept. The back picture holds it in the
  barcode, as the front shows it in print; both are kept encrypted and deleted together.
- **Columns.** `id_flags` and `check_matched` are `jsonb`, as `client_ids` is.

### Layer B

- `check.method` `record_match` is accepted from Vibe Files only, with `matched` not empty.
  `callback` and `other` need a note. `vendor` is refused until layer C.
- New answers: `check_required`, `check_invalid`, `check_note_required`.
- The check is in the approval's History entry, in the words the PDF uses.

### Layer C, when it is built

- The SMTP password is not sealed: it is an environment variable. The pattern for a sealed
  secret is the B2 application key (`ctx.keyring.wrap`, **Check and save**, **Test**, `hasKey`).
- The portal has no inbound hook. The route must be mounted with a raw body before the JSON
  parser in `apps/api/src/app.ts`, and its signature check is new code.
