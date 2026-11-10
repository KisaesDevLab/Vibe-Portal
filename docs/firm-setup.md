# Setting up Vibe Portal for your firm

Vibe Portal is your firm's client file portal. Staff share files with clients from Vibe Files;
clients sign in to download them and to send documents back, which arrive in Vibe Files' Intake.
It runs on your Vibe appliance, at its own address such as `https://files.yourfirm.com`.

You need: the Vibe appliance (installed with `vibe-installer`), Vibe Files on the office PCs, an
email account the portal can send from (SMTP), and optionally a Twilio account for text messages.

## 1. Choose the address

Pick a hostname under your firm's domain, for example `files.yourfirm.com`. Clients see it in
every email, so choose something they will trust. It must be a name, not an IP address, and not
the appliance's own hostname.

- **Appliance behind the Cloudflare Tunnel** (the usual case): nothing to do in DNS yet; step 3
  adds it to the tunnel.
- **Appliance with its own certificate (Let's Encrypt or internal)**: point the hostname's DNS
  record at the appliance before installing.

## 2. Install it on the appliance

Have the email settings ready. Office 365 example:

| Setting | Example |
|---|---|
| SMTP server | `smtp.office365.com` |
| Port | `587` (STARTTLS; use `465` for a server that wants TLS from the start) |
| User and password | a mailbox licensed to send, e.g. `portal@yourfirm.com` |
| From | `Your Firm CPA <portal@yourfirm.com>` |

Then, on the appliance:

```sh
sudo vibe install portal --host files.yourfirm.com
```

It asks for the email settings (or reads `VIBE_PORTAL_SMTP_HOST`, `VIBE_PORTAL_SMTP_PORT`,
`VIBE_PORTAL_SMTP_USER`, `VIBE_PORTAL_SMTP_PASS`, `VIBE_PORTAL_SMTP_SECURE` and
`VIBE_PORTAL_EMAIL_FROM` from the environment). The portal checks the email server when it
starts; a wrong password shows in `sudo vibe logs portal`.

**Text messages (optional).** To let clients sign in with a code sent to their phone, set
`VIBE_PORTAL_TWILIO_ACCOUNT_SID`, `VIBE_PORTAL_TWILIO_AUTH_TOKEN` and
`VIBE_PORTAL_TWILIO_FROM_NUMBER` before installing. Without them clients sign in by email only.
US numbers need A2P 10DLC registration with Twilio first.

## 3. Cloudflare Tunnel

In Cloudflare Zero Trust › Networks › Tunnels, open the appliance's tunnel and add a public
hostname:

- **Hostname**: `files.yourfirm.com`
- **Service**: the same as the appliance's main hostname
- **Additional application settings › TLS**: turn on **No TLS Verify**, as for the main
  hostname. Without it Cloudflare answers 502.

Open `https://files.yourfirm.com/health` from a phone on mobile data: it should answer with `"status":"ok"`.

## 4. The first staff account

On the appliance:

```sh
sudo vibe portal setup-link
```

Open the link it prints (it works once, for 3 days). Enter your email, name and a password of
12 characters or more, then add the portal to an authenticator app (Microsoft Authenticator,
Google Authenticator, 1Password, …) and type the code it shows. You are now signed in to the
staff page at `https://files.yourfirm.com/staff`.

On the staff page, **Settings**:

- **Firm**: the name and colour clients see, the largest file clients may send (up to 100 MB),
  and how long files Vibe Files has collected stay on the portal.
- **Logo**: a PNG or JPEG up to 512 KB.
- **Staff**: add the other staff who should use the staff page; each gets a setup link by
  email. **New setup link** helps someone who lost their phone or is locked out (also
  `sudo vibe portal staff-reset <email>` on the appliance).
- **Portal keys**: **Make a key** for Vibe Files (next step). It is shown once.

## 5. Connect Vibe Files

On any office PC, in Vibe Files › **Admin › Portal** (admin password needed):

1. **Portal address**: `https://files.yourfirm.com`
2. **Portal key**: paste the key from step 4 (it starts with `vpk_`).
3. Press **Test**, then **Save**.

The settings are kept in the cabinet, so every PC uses them. Saving adds the `_Portal inbox`
folder to Intake; press **Reload Intake** when it asks. Each PC collects client uploads every 5
minutes; only one PC collects each upload.

## 6. Try it

1. In Vibe Files, select a test client, press **Portal users…**, and invite yourself at a
   personal email address.
2. Accept the invitation on your phone.
3. Share a document with yourself (**Share…** in the file pane) and open it on the phone.
4. Upload a photo from the phone. Within a few minutes it is in `_Portal inbox`, named after
   the client, and Intake files it.

## Backups

`sudo vibe backup portal` saves the database and `data/.firm-key.seal`. Keep both: the seal
file unlocks every stored file, and without it they cannot be read. The cabinet keeps the
original of everything you share, so the portal's files can always be shared again; client
uploads not yet collected by Vibe Files exist only on the portal.

## When something is wrong

| What you see | What to check |
|---|---|
| Cloudflare 502 on the portal address | **No TLS Verify** on the tunnel's public hostname (step 3) |
| Clients get no email | `sudo vibe logs portal` for the SMTP error; the mailbox may need SMTP AUTH turned on (Office 365: Admin center › user › Mail › Manage email apps) |
| Vibe Files' **Test** says the key is not accepted | The key was revoked or mistyped: make a new one on the staff page |
| Uploads do not arrive | In Vibe Files › Admin › Portal, press **Fetch uploads now** and read the message it shows; the staff page's **Uploads** lists what is still waiting |
| Staff locked out | Wait 15 minutes, or `sudo vibe portal staff-reset <email>` |
