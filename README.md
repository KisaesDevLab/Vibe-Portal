# Vibe Portal

A client file portal for firms that run **Vibe Files** but not **Vibe Practice Management**.
Staff share files with clients from Vibe Files; clients sign in to download them and to upload
documents, which come back into Vibe Files' Intake. Installed as an app on the Vibe Appliance.

## Set it up

About 20 minutes. You need:

- **The Vibe Appliance**, set up with your firm's domain. The portal lives at its own address,
  `https://files.<your domain>` (for example `https://files.yourfirm.com`).
- **A mailbox the portal can send from**, such as `portal@yourfirm.com`, with its password.
  Sign-in links and codes go by email, so the portal does not start without it.
- **Your phone**, with an authenticator app (Microsoft Authenticator, Google Authenticator,
  1Password, …). Staff sign in with a password and a code from the app.
- **Vibe Files** on the office PCs.

### 1. Email settings

In the appliance console, open **Settings › Apps › Vibe Portal › Email & SMS** and fill in:

| Setting            | What to enter                    | Office 365 example                    |
| ------------------ | -------------------------------- | ------------------------------------- |
| SMTP host          | your mail provider's SMTP server | `smtp.office365.com`                  |
| SMTP port          | usually 587                      | `587`                                 |
| SMTP username      | the sending mailbox              | `portal@yourfirm.com`                 |
| SMTP password      | that mailbox's password          |                                       |
| TLS from the start | leave on **Automatic**           |                                       |
| From address       | the name and address clients see | `Your Firm CPA <portal@yourfirm.com>` |

Office 365: the mailbox must be allowed to send by SMTP (Microsoft 365 admin center › the user ›
Mail › Manage email apps › **Authenticated SMTP** on).

### 2. The first admin

On the same page, **Settings › Apps › Vibe Portal**, under **Application**, fill in **First
admin's email** with your own email, and **Save**.

To check the email settings now, use **Send a test email** in the **Actions** section at the
bottom of that page once the portal is running (step 3). If it fails, it says what is wrong.

### 3. Turn the portal on

On the console's **Apps** page, press **Enable** on the **Vibe Portal** tile. It refuses, and says
which, while the SMTP host or From address is empty. Once it starts, the portal emails you a link
to make the first staff account.

### 4. Make your staff account

1. Open the email **"Set up your firm's client portal"** and its link. It works for 3 days.
2. Enter your name and choose a password of at least 12 characters.
3. In your authenticator app, add an account and scan the QR code the page shows (or, under
   **Can't scan it?**, type in its key). Then type the 6-digit code the app shows.

You are now signed in to the staff page at `https://files.<your domain>/staff`. Bookmark it.

**No email?** Look in the junk or spam folder. Then open `https://files.<your domain>/staff`:
it says where the link was sent and has a **Send again** button. If it says the email could not
be sent, the email settings in step 1 need fixing: **Send a test email** (Settings › Apps › Vibe
Portal › Actions) says what is wrong. Correct them, save, and press **Send again**.

Email not working at all? **Get a staff setup link** in the same **Actions** section shows a link
on the screen instead.

### 5. Set up the firm

On the staff page, **Settings**:

- **Firm**: your firm's name and colour, which clients see.
- **Logo**: a PNG or JPEG up to 512 KB.
- **Staff**: add the other staff. Each gets an email with their own setup link. Tick **Admin**
  for anyone else who should manage settings.
- **Portal keys**: press **Make a key** for Vibe Files. It is shown once: copy it now.

### 6. Connect Vibe Files

On any office PC, in Vibe Files › **Admin › Portal**:

1. **Portal address**: `https://files.<your domain>`
2. **Portal key**: paste the key from step 5 (it starts with `vpk_`).
3. Press **Test**, then **Save**.

Every PC then uses the same settings. Saving adds a `_Portal inbox` folder to Intake, where client
uploads arrive.

### 7. Try it

1. In Vibe Files, pick a test client, press **Portal users…**, and invite yourself at a personal
   email address.
2. Accept the invitation on your phone.
3. Share a document with yourself (**Share…** in the file pane) and open it on the phone.
4. Upload a photo from the phone. Within a few minutes it is in `_Portal inbox`.

### Optional: keep files in Backblaze B2

Files are kept on the appliance unless you move them. To keep them in a Backblaze B2 bucket
instead, see **Settings › Storage** on the staff page and
[docs/firm-setup.md](docs/firm-setup.md#storing-files-in-backblaze-b2-optional).

### Optional: staff sign in with Vibe Auth

When Vibe Auth is installed on the appliance, the console registers the portal with it. An
admin then turns it on: **Settings › Sign-in with Vibe Auth**, **Test connection**, and Sign-in
mode **both**. The staff sign-in page gets a **Sign in with …** button beside the password
sign-in. Anyone in Vibe Auth can then sign in to the staff page; an account is made the first
time. Vibe Auth's groups decide who is an admin (vibe-admin, vibe-it and vibe-partner are
admins; others are staff), and Vibe Auth asks for the second step, not the portal. See
[docs/firm-setup.md](docs/firm-setup.md#staff-sign-in-with-vibe-auth-optional).

### If something is wrong

| What you see                                | What to do                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Enable** refuses                          | Fill in the SMTP host and From address (step 1) and save                                                            |
| The setup email never arrives               | Junk folder; then `https://files.<your domain>/staff` › **Send again**; check the email settings                    |
| The page says the email could not be sent   | **Send a test email** (Settings › Apps › Vibe Portal › Actions) says what is wrong                                  |
| A staff member lost their phone             | An admin presses **New setup link** for them on the staff page (Settings › Staff), or the console's **Reset a staff member's sign-in** |
| No admin can sign in                        | **Reset a staff member's sign-in** in the console makes them admin when no other admin has an account; otherwise the command below with `--admin` |
| No **Sign in with …** button                | An admin has not set Sign-in mode **both** (Settings › Sign-in with Vibe Auth), or Vibe Auth is not installed |
| Vibe Auth is down and nobody can sign in    | Open `https://files.<your domain>/staff/login?local=1` and sign in as `vibe-breakglass@vibe-auth.local` with the password the console keeps |
| Vibe Files' **Test** says the key is wrong  | Make a new key on the staff page (Settings › Portal keys)                                                           |

### Commands on the appliance

The **Actions** buttons on Settings › Apps › Vibe Portal do the same as these. The commands are
only needed when the console cannot be used, or to make someone an admin (`--admin`). Run them on
the appliance (over SSH), and copy them exactly:

```sh
# A link to make the first staff account (while there is none), printed on the screen:
sudo docker exec vibe-files-portal node_modules/.bin/tsx src/scripts/staff-setup.ts link

# Send a test email with the portal's settings; says what is wrong if it fails:
sudo docker exec vibe-files-portal node_modules/.bin/tsx src/scripts/test-email.ts you@yourfirm.com

# A new setup link for a locked-out staff member (add --admin if no admin can sign in):
sudo docker exec vibe-files-portal node_modules/.bin/tsx src/scripts/staff-setup.ts reset them@yourfirm.com
```

More detail (backups, secure links to people outside a client, B2 storage):
[docs/firm-setup.md](docs/firm-setup.md).

## For developers

See [BUILD_PLAN.md](BUILD_PLAN.md) for the design and phases, and [QUESTIONS.md](QUESTIONS.md)
for decisions.

Node 24, pnpm 9, and Docker for the database.

```sh
pnpm install
cp .env.example .env
pnpm docker:up        # Postgres on localhost:5433
pnpm dev              # API on :3101 (applies migrations), portal on :5197
pnpm gate             # typecheck, lint, format, headers, tests, build
```

The image is `ghcr.io/kisaesdevlab/vibe-portal`, built from the `Dockerfile`.

Licence: PolyForm Small Business 1.0.0 (see `LICENSE.md`). Parts are copied from Vibe Time &
Billing; see [VENDORED.md](VENDORED.md).
