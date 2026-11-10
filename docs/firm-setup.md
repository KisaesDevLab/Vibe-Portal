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
- **Appliance with a Let's Encrypt certificate**: point the hostname's DNS record at the
  appliance before installing, and let ports 80 and 443 reach it from the internet.
- An appliance with an **internal** (self-signed) certificate does not suit the portal: clients'
  phones and Vibe Files will not trust it. Use the Cloudflare Tunnel.

## 2. Install it on the appliance

Have the email settings ready. Office 365 example:

| Setting           | Example                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| SMTP server       | `smtp.office365.com`                                                   |
| Port              | `587` (STARTTLS; use `465` for a server that wants TLS from the start) |
| User and password | a mailbox licensed to send, e.g. `portal@yourfirm.com`                 |
| From              | `Your Firm CPA <portal@yourfirm.com>`                                  |

Then, on the appliance:

```sh
sudo vibe install portal --host files.yourfirm.com
```

It asks for the email settings. The portal checks the email server when it starts; a wrong
password shows in `sudo vibe logs portal`.

**Text messages (optional).** To let clients sign in with a code sent to their phone, give the
Twilio settings on the same line as the install (`sudo` does not pass on variables set with
`export`):

```sh
sudo VIBE_PORTAL_TWILIO_ACCOUNT_SID=AC… VIBE_PORTAL_TWILIO_AUTH_TOKEN=… \
     VIBE_PORTAL_TWILIO_FROM_NUMBER=+15551234567 \
     vibe install portal --host files.yourfirm.com
```

Without them clients sign in by email only. With them, a client invited by email can add a
mobile number on their home page (**Sign in by text**); it is used once they type back the code
texted to it. A number you type beside the email on an invitation is offered to them the same way. US numbers need A2P 10DLC registration with
Twilio first. To add texts later, set `SMS_PROVIDER=twilio` and the `TWILIO_*` lines in
`/etc/vibe/portal/.env`, then run `sudo vibe upgrade portal` (it starts the portal again with
the new settings).

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

- **Firm**: the name and colour clients see, the largest file (up to 95 MB, under Cloudflare's
  limit; it applies both to what clients send and to what Vibe Files shares), and how long
  files Vibe Files has collected stay on the portal.
- **Logo**: a PNG or JPEG up to 512 KB.
- **Staff**: add the other staff who should use the staff page; each gets a setup link by
  email. **New setup link** helps someone who lost their phone: it clears their password and
  authenticator, and they set both again from the link (also
  `sudo vibe portal staff-reset <email>` on the appliance, which also turns a turned-off
  account back on).
  - **Admin**: only admins see Settings. The first account is an admin; tick **Admin** when
    adding someone, or use **Access** later. You cannot change your own access, so an admin
    always remains.
  - **Access**: staff see every client unless you limit them. Choose **Sees only these
    clients** and tick the clients: that person then sees only those clients' people, files,
    uploads and history, and not the access requests. An admin always sees every client. The
    change applies at once. This limits the staff page only: Vibe Files on the office PCs
    shows every client, as before.
- **Portal keys**: **Make a key** for Vibe Files (next step). It is shown once.

## 5. Connect Vibe Files

On any office PC, in Vibe Files › **Admin › Portal** (admin password needed):

1. **Portal address**: `https://files.yourfirm.com`
2. **Portal key**: paste the key from step 4 (it starts with `vpk_`).
3. Press **Test**, then **Save**.

The settings are kept in the cabinet, so every PC uses them. Saving adds the `_Portal inbox`
folder to Intake; press **Reload Intake** when it asks. While Vibe Files is open, each PC
collects client uploads every few minutes (**Fetch client uploads every**, 5 minutes unless you
change it); only one PC collects each upload. With every PC closed, uploads wait on the portal.

## 6. Try it

1. In Vibe Files, select a test client, press **Portal users…**, and invite yourself at a
   personal email address.
2. Accept the invitation on your phone.
3. Share a document with yourself (**Share…** in the file pane) and open it on the phone.
4. Upload a photo from the phone. Within a few minutes it is in `_Portal inbox`, named after
   the client, and Intake files it.

## Sending a file to someone outside the client

A lender, a lawyer or another accountant sometimes needs a client's document. They are not one of
the client's people, so they get no portal account. Send them a **secure link** instead, from the
staff page:

1. Open the client. Beside a file under the shared files press **Send securely…**. The file must
   already be on the portal: share it from Vibe Files first.
2. Tick any other files of this client to send with it (up to 20).
3. Enter the **recipient's email**, and their name and organization if you like (the recipient
   sees them on the page, and they go in the watermark).
4. **Access**: **View only** shows PDFs and pictures (PNG, JPEG) on the page with no download
   button; it cannot stop a screenshot. **View and download** is needed for any other kind of
   file.
5. **Link works for** 7, 30 or 90 days.
6. **Watermark PDFs** prints the recipient's name, organization and the day they opened it across
   every page. It works for PDFs up to 30 MB that are not locked with a password.
7. Add a message for the email if you like, and press **Send secure link**.

What the recipient gets:

- An email from your firm with a private link. It names neither the client nor the files.
- On the page they press **Send access code**: a 6-digit code goes to the same address and lasts
  10 minutes. Only someone who reads that mailbox gets in.
- After the code the documents open for 30 minutes. Then the page locks, and a new code opens it
  again, as often as needed until the link expires.

**Secure links sent outside**, on the client's page, lists every link: to whom, which files,
whether it was opened and how often. **Revoke** ends a link at once, even while it is open. Also:

- 15 wrong codes in a row end a link (**Locked**), in case it reached the wrong hands. Send a new
  one.
- One recipient can hold 5 working links for the same client at a time. Revoke an old one to
  send another.
- Each link may be downloaded 5 times in all, unless an admin changes **Downloads allowed per
  secure link** on Settings › Firm (0 for no limit). A link keeps the number set when it was sent.
  Viewing on the page is not a download. The client's page shows how many downloads each link has
  had.
- **Remove** a file from the portal and it leaves every link. Switch a client off and its links
  stop for as long as it is off.
- When Vibe Files updates a file, links show the new version. If the new version no longer suits
  the link (a view-only link and a file the page cannot show, or a watermarked PDF now over
  30 MB), the recipient sees it as **Not available**: send it again with other settings.
- **History** shows each link sent and revoked, each code sent, and every view and download with
  the recipient's email.

## Storing files in Backblaze B2 (optional)

Shared files and client uploads are kept on the appliance unless you move them to a B2 bucket.
They are encrypted on the appliance first, so B2 only ever holds files it cannot read.

1. In Backblaze, make a **private bucket for the portal alone**, without Object Lock, and an
   **application key** limited to that bucket that may read, write, list and delete files.
2. On the staff page, **Settings > Storage**: enter the bucket's **Endpoint** (on the bucket's
   page, like `s3.us-west-004.backblazeb2.com`), the **Bucket name**, the **Key ID** and the
   **Application key**, and press **Check and save**. The portal writes, reads and deletes a small
   test file first, and refuses a bucket with Object Lock (files removed from the portal could not
   be deleted from it). The application key is not shown again. The portal leaves its mark in the
   bucket, and another portal is refused the same bucket.
3. Press **Move files to B2**. The portal keeps working while it runs; the page shows how far it
   is. Files are deleted from the appliance only once every one is in the bucket. If the move stops,
   nothing is lost: each file is in the bucket or still on the appliance, and opens from there
   while the appliance can reach the bucket. A move cut off by a restart starts again by itself
   when the portal is back (up to three times); one stopped by the connection waits for you to
   press it again.

**Move files back to the appliance** does the reverse. It does not start unless the appliance has
room for every file with a margin. While
files are in the bucket it cannot be changed or removed; a new application key for it can be
saved at any time. The portal also has a `storage-move` command (`status`, `b2`, `local`) for the
appliance; it is not yet offered as `vibe portal storage-move` by the installer.

A file removed from the portal is deleted from the bucket with all its versions. If the bucket
cannot be reached at that moment, a daily check deletes it later. That check deletes nothing when
it finds more than a tenth of the stored files named by no file or upload: the database is then
older than the files (an old backup restored), and Settings > Storage says so.

## Backups

`sudo vibe backup portal` writes a snapshot under `/var/lib/vibe/portal/backups/` with the
database (also as a `pg_dump` file) and `data/.firm-key.seal`. Copy it off the appliance, and
keep the seal file with it: it unlocks every stored file, and without it they cannot be read. The cabinet keeps the
original of everything you share, so the portal's files can always be shared again; client
uploads not yet collected by Vibe Files exist only on the portal.

With files in B2, each file's own key is in the database, wrapped by the firm key that the seal
file unlocks: the bucket alone opens nothing. So the portal also sends an encrypted copy of its
database to the bucket every hour, and as soon as a move to B2 finishes; the bucket keeps the
newest 48 (two days). Settings > Storage shows when the last one went (**Send a database copy now** sends
one at once), and History records it if one fails. **The bucket and the seal file are then
enough to get everything back.** Keep a copy of `data/.firm-key.seal` somewhere other than the
appliance and other than the bucket: without it neither the copies nor the files can be opened.
What changed after the last copy (at most an hour) is lost: a file shared since can be shared again from
Vibe Files, but **a client upload that arrived since and was not yet collected by Vibe Files
cannot be opened**, and is gone. **Remove bucket** deletes these copies from the bucket too.

To restore onto a new appliance from the bucket: install the portal, start it once and stop it,
then run the portal's `snapshot-restore` command with the bucket's settings (`B2_ENDPOINT`,
`B2_BUCKET`, `B2_KEY_ID`, `B2_APP_KEY`): `snapshot-restore list` shows the copies, and
`snapshot-restore restore --seal <old .firm-key.seal>` restores the newest and puts the old seal
file back in place. Start the portal; everyone signs in again. The installer does not offer this
as a `vibe portal` command yet.

`sudo vibe backup portal` snapshots are still worth taking: they hold the database as of when
they were taken, and a restore from one made before the last move may name the other place.

## When something is wrong

| What you see                                                                 | What to check                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare 502 on the portal address                                         | **No TLS Verify** on the tunnel's public hostname (step 3)                                                                                                                              |
| Clients get no email                                                         | `sudo vibe logs portal` for the SMTP error; the mailbox may need SMTP AUTH turned on (Office 365: Admin center › user › Mail › Manage email apps)                                       |
| Vibe Files' **Test** says the key is not accepted                            | The key was revoked or mistyped: make a new one on the staff page                                                                                                                       |
| Uploads do not arrive                                                        | Is Vibe Files open on some PC? In Admin › Portal press **Fetch uploads now**; a problem shows in the bar at the top of Browse. The staff page's **Uploads** lists what is still waiting |
| Staff locked out after wrong tries                                           | Wait 15 minutes. Lost phone: an admin sends **New setup link**, or `sudo vibe portal staff-reset <email>`                                                                               |
| No admin can sign in (left the firm, lost phone)                             | `sudo vibe portal staff-reset <email> --admin` for a staff member: they get a new setup link and become an admin                                                                        |
| A staff member does not see a client, or has no **Requests** or **Settings** | An admin limited them: Settings › Staff › **Access**                                                                                                                                    |
| Someone sent a secure link gets no access code                               | Their spam folder. One code a minute and ten a day per link. `sudo vibe logs portal` for the SMTP error                                                                                 |
| Someone sent a secure link sees **Access locked**                            | 15 wrong codes ended the link: send a new one from the client's page                                                                                                                    |
| **Send securely** says a PDF cannot be watermarked                           | The PDF is locked with a password or damaged: send it without the watermark, or share an unlocked copy from Vibe Files                                                                  |
