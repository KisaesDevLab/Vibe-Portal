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

### 1. Turn the portal on

In the appliance console, enable **Vibe Portal**.

### 2. Email settings

In the appliance console, open **Settings › Vibe Portal › Email & SMS** and fill in:

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

### 3. The first admin

In **Settings › Vibe Portal**, enter **your own email** as the first admin, and **Save**. The
portal starts and emails you a link to make the first staff account.

### 4. Make your staff account

1. Open the email **"Set up your firm's client portal"** and its link. It works for 3 days.
2. Enter your name and choose a password of at least 12 characters.
3. In your authenticator app, add an account and type in the key the page shows (or open the
   page's link on your phone). Then type the 6-digit code the app shows.

You are now signed in to the staff page at `https://files.<your domain>/staff`. Bookmark it.

**No email?** Look in the junk or spam folder. Then open `https://files.<your domain>/staff`:
it says where the link was sent and has a **Send again** button. If it says the email could not
be sent, the email settings in step 2 need fixing; correct them, save, and press **Send again**.

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

### If something is wrong

| What you see                                | What to do                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The portal does not start after enabling it | Fill in the email settings (step 2) and save: it needs an SMTP host and From address                                |
| The setup email never arrives               | Junk folder; then `https://files.<your domain>/staff` › **Send again**; check the email settings                    |
| The page says the email could not be sent   | The SMTP username, password or port is wrong, or the mailbox may not send by SMTP (Office 365: Authenticated SMTP)  |
| A staff member lost their phone             | An admin opens Settings › Staff on the staff page and presses **New setup link** for them                           |
| No admin can sign in                        | See "Commands on the appliance" below                                                                               |
| Vibe Files' **Test** says the key is wrong  | Make a new key on the staff page (Settings › Portal keys)                                                           |

### Commands on the appliance

Only needed when the steps above cannot be used, for example when email is not working yet. Run
them on the appliance (over SSH), and copy them exactly:

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
