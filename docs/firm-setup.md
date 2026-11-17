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
- **Logo**: a PNG or JPEG up to 512 KB. The portal follows each device's light or dark setting,
  so you can add a second **Logo for dark mode** (light lettering on a clear background) under
  it. Devices in dark mode show that one; without it they show the usual logo.
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
  - **Access requests**: tick this for whoever should be emailed when someone asks for access
    (from the sign-in page's **Request access**). The email comes once the person has confirmed
    their email or phone, with their name and who they say they are with; their contact and
    note are on the staff page's **Access requests**, where you choose their client and approve
    or deny. Only staff who see every client can be ticked, since only they see the requests.
    Someone who should see more than one client (a spouse on a joint return and the family
    business, say): choose each client in turn before **Approve**; they sign in once and switch
    between their clients at the top of their page. To add a client for someone later, invite
    the same email or phone to it from Vibe Files.
    Unless you change it, every request comes with a **photo ID** (a driver's license, state
    ID or passport: a phone photo, a scan or a PDF), shown with the request; open it full size
    by clicking it. An admin can change what is asked on **Settings › Access requests** (see
    below). When you
    approve, the portal makes a PDF of the request and the photo ID, and Vibe Files fetches it
    into the Portal inbox like an upload, named with the first client's name and code and the
    person's name, and the date and time of the approval (`Smith, John_1001_Access request - Mary Smith - 2026-11-11 1430.pdf`): file it from Intake. The
    person never sees it. The portal deletes the photo ID (both sides, and what the barcode said), and its own copy of the PDF, 7 days
    after Vibe Files fetched the PDF, and in any case 90 days after approval (if Vibe Files never fetched it, the Log says so); a denied request's photo ID 30 days after the denial.
- **Access requests**: what someone who asks for access must send, and what staff must do
  before approving. People you invite are not asked for any of this.
  - **ID with a request**: **None**, **A picture of a photo ID** (what a firm has until it
    changes this; a file, or a picture taken there with the phone's camera or the computer's
    webcam), or **Front and back, barcode read**. With front and back, the person
    photographs both sides (with a phone's camera, or a computer's webcam; a phone usually
    reads the barcode better), and the portal reads the barcode on the back of a US or
    Canadian license or ID. Staff see the name, date of birth, address
    and expiry beside both pictures, with a flag when the ID has expired, the name differs from
    the request's, the barcode could not be read, or the person said the ID has no barcode (a
    passport or an ID from another country: front only). It catches a wrong or old ID. It does
    not prove the ID is genuine: a barcode can be made by anyone, so compare it with the front.
    With **None**, only the email or mobile number is confirmed; the approval PDF is still
    made.
  - **Check before approving**: with **Required**, **Approve** asks how you checked the person:
    called the number in your records (and who you spoke to), met in person, or you know them
    another way (and how). A text or email to the contact on the request does not count: that
    contact is what is being checked. The answer is in History and in the approval PDF. In
    Vibe Files, a request that matches the client's row of your client list (its email, mobile
    or date of birth; choose the columns in Admin › Portal) approves in one step.
    **Update Vibe Files before choosing Required**: an older Vibe Files cannot approve while
    it is required, and shows "The portal said no (400: check_required)"; approve on this
    page meanwhile.
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

1. Open the client. Beside a file under the shared files press **Send securely…**. To send
   several in one link, tick them first and press **Send securely…** in the bar that appears
   above the list (a link holds at most 20 files). The file must
   already be on the portal: share it from Vibe Files first.
2. Tick any other files of this client to send with it (up to 20).
3. Enter the **recipient's email**, and their name and organization if you like (the recipient
   sees them on the page, and they go in the watermark).
4. **Access** starts as **View and download**, which any kind of file needs. **View only**
   shows PDFs and pictures (PNG, JPEG) on the page with no download button; it cannot stop a
   screenshot.
5. **Link works for** 7 days to start with; choose 14, 30 or 90 if it should last longer.
6. **Watermark PDFs** starts ticked. It prints the recipient's name, organization and the day
   they opened it across every page. A PDF that cannot be watermarked (locked with a password,
   damaged, or over 30 MB) is sent as it is, and the page tells you which when the link is
   sent. Untick the box to send every PDF as it is.
7. Add a message for the email if you like, and press **Send secure link**.

What the recipient gets:

- An email from your firm with a private link. It names neither the client nor the files.
- On the page they press **Send access code**: a 6-digit code goes to the same address and lasts
  10 minutes. Only someone who reads that mailbox gets in.
- After the code the documents open for 30 minutes. Then the page locks, and a new code opens it
  again, as often as needed until the link expires.

**Secure links sent outside**, on the client's page, lists every link: to whom, which files,
whether it was opened and how often. **Revoke** ends a link at once, even while it is open.
**Resend** emails the recipient a new link to the same files, with the same access and end date:
the portal keeps no copy of a link, so the one they had stops working, and they give a new access
code. Resend also opens a link that was **Locked**. Also:

- 15 wrong codes in a row end a link (**Locked**), in case it reached the wrong hands. Send a new
  one.
- One recipient can hold 5 working links for the same client at a time. Revoke an old one to
  send another.
- Each file in a link may be downloaded 5 times, unless an admin changes **Downloads allowed per
  secure link** on Settings › Firm (0 for no limit). It counts per file: a link of six files lets
  each of them be downloaded. A link keeps the number set when it was sent. Viewing on the page is
  not a download. The client's page shows each file's downloads beside it.
- **Remove** a file from the portal and it leaves every link. Switch a client off and its links
  stop for as long as it is off.
- When Vibe Files updates a file, links show the new version. If the new version no longer suits
  the link (a view-only link and a file the page cannot show, or a watermarked PDF now over
  30 MB), the recipient sees it as **Not available**: send it again with other settings.
- **History** shows each link sent and revoked, each code sent, and every view and download with
  the recipient's email.

## Seeing the documents Vibe Files has in B2 (optional)

Vibe Files can keep documents in your firm's own B2 bucket (its **Sync** tab). Vibe Files
encrypts them with your sync passphrase before they go up, so the bucket alone shows nothing.
Vibe Files can send the portal a list of them, so staff see on the staff page which clients have
documents in B2 and what they are. It needs Vibe Portal 0.3.15 and Vibe Files 0.1.38, or later.

1. Update the portal first (`sudo vibe upgrade portal`), then Vibe Files on every PC.
2. In Vibe Files › **Admin › Portal**, tick **Show the documents in B2 on the portal's staff
   page** and press **Save**. Every PC follows the setting. The computer B2 sync runs on sends
   the lists about every 10 minutes while Vibe Files is open there, and only the lists that
   changed.
3. On the staff page, **Clients** shows every client with documents in B2 (the **In B2** column),
   whether or not anything was shared with them. A client's page has **Documents in B2 (from Vibe
   Files)**: each document's name, folder, tax year and size, and whether it is on the portal.

What to know:

- **Names only.** The list holds no document. To put one on the portal, share it from Vibe Files
  as before; the list then says **Yes** under **On the portal**. Or let the portal read the
  bucket itself: see **Adding a document in B2 to the portal from the staff page** below.
- **Only what is in B2.** Documents held back by Vibe Files' **Sync › What goes to B2** are not
  listed. Change the rule, or push a document by hand, to list it.
- **Staff only.** Clients' people see what was shared with them and nothing of this list. A staff
  member limited to some clients sees those clients' lists only.
- **Limits.** One client's list holds at most 20,000 documents, and a document's folder and name
  together at most 500 characters. A client over either gets no new list (the portal shows the
  last one sent, if any), and Vibe Files says which client, in Browse.
- **Several PCs.** Where each PC runs B2 sync itself (a plain shared folder, not server or cloud
  mode), each of them sends, and the portal keeps one list per client: the newest, and between
  two made from the same state of the bucket, always the same one.
- **Turning it off.** Untick the setting in Vibe Files and save: the lists leave the portal at
  once (History says so). **Stop using the portal** removes them too, and so does changing the
  portal address (from the portal used before). Clients the lists made stay, with nothing in
  them, ready to invite.
- **A new B2 bucket.** When B2 sync is set up again on a new bucket, Vibe Files removes the old
  bucket's lists from the portal before it sends the new ones.
- The file names are kept in the portal's database, like the names of shared files.
- The lists are not in the hourly database copy sent to the portal's own bucket (see
  **Backups**): after a restore from it they are empty until Vibe Files sends them again, about
  10 minutes after Vibe Files is next open on the computer B2 sync runs on.

### Adding a document in B2 to the portal from the staff page (optional)

Staff can put a document from the list on the portal without going to Vibe Files: the portal
reads it from the B2 bucket Vibe Files' sync uses. It needs Vibe Portal 0.3.17 or later (0.3.16
where the portal keeps its own files in that same bucket); Vibe Files needs nothing newer than
the 0.1.38 the list itself needs.

1. On the staff page, **Settings**, in the card **Vibe Files' documents in B2** (below
   **Storage**; a part of the Storage card before 0.3.19), say where Vibe Files' documents are:
   - **In a bucket of Vibe Files' own** (the usual case, and the only one for a bucket with
     **Object Lock**): enter that bucket's **endpoint**, **name**, a **key ID** and its
     **application key**. The portal only reads this bucket, so make the key in Backblaze for
     this bucket alone, of the kind Backblaze calls **Read Only** (it may read and list files
     and nothing more). The key must reach the whole bucket, not one folder of it. To enter
     the passphrase again later, leave the application key empty: the saved one is kept.
   - **In the bucket above**, where the portal keeps its own files in the same bucket as Vibe
     Files (possible only without Object Lock). The portal keeps to its own folders there
     (`blobs/` and `portal/`) and only reads Vibe Files' (`vf/`).
2. Enter Vibe Files' **sync passphrase** and press **Check and save the passphrase**. The
   portal checks it against the bucket.
3. On a client's page, each document under **Documents in B2 (from Vibe Files)** that is not on
   the portal has **Add to portal**. The portal reads the document from the bucket and keeps
   its own copy.
4. The document is then under **Files**, shown to nobody: choose who sees it there, or send it
   by a secure link, as for any file.

What to know:

- **The appliance can then open every document Vibe Files has in the bucket**, not only the
  ones added. Until the passphrase is entered it can open none. Anyone who gets into the
  appliance gets that too. Leave it out if that matters more than the convenience; sharing from
  Vibe Files works as before either way.
- The passphrase itself is not kept. The key it opens is, encrypted with the portal's own key,
  as the bucket's application key is. **Remove** takes it off the portal again; documents
  already added stay (and no longer follow the bucket). Where Vibe Files' documents are read
  from the portal's own bucket, changing or removing that bucket forgets the key too (History
  says so): enter the passphrase again for the new bucket.
- Like the portal's own bucket key, the saved key (and the key of Vibe Files' bucket) is in the portal's backups and in the hourly
  database copy sent to the bucket, encrypted with the portal's own key. **Remove** does not
  reach copies already made, and a restore from one made before it brings the key back: press
  **Remove** again after such a restore.
- The document is read as the bucket has it at that moment. One deleted, or taken out of B2, in
  Vibe Files since the list was sent is refused, and says so.
- A document larger than the portal's largest upload is refused.
- Vibe Files finds a document added this way as one it shared itself: Browse marks it, and
  sharing it again from Vibe Files does not add it twice.
- **A document added this way follows B2.** When it changes in the cabinet and Vibe Files
  pushes the new version to B2, the portal replaces its copy by itself, within about 10
  minutes: the people who see it get it marked **New**, without anyone at the firm looking
  first. No email or text is sent for an update the portal made by itself. History says **Replaced a file**, by **Vibe
  Files' B2**, and the file's row under **Files** says it was added from B2. A new name in the
  cabinet follows too (nobody is told of a new name alone). A secure link that holds the file
  gives the new version from then on.
- A document added from B2 stops following it once someone shares a changed version of it from
  Vibe Files: it is then Vibe Files' to replace, as any file shared from there. To stop one
  following without that, remove it from the portal and share it from Vibe Files instead.
- Documents added with 0.3.16 follow B2 from the update to 0.3.17 on. Removal with B2, and
  updates without a notice, need 0.3.18. **At the update to 0.3.18**, a copy whose document
  had already left B2 (which 0.3.17 kept) is removed too, within about 20 minutes.
- If the portal cannot read the bucket (the key was removed in Backblaze, the sync key
  changed), nothing is updated, and **Settings › Storage** says so.
- **A document that leaves B2 leaves the portal.** The portal removes its copy by itself, as
  if staff had removed it, when in Vibe Files the document is:
  - **deleted** (alone, or with its folder);
  - **taken out of B2** (Sync › **Remove the selected documents from B2…**); a change to the
    rule under **What goes to B2** takes nothing out, so it removes nothing here;
  - **moved to another client**: it is no longer this client's to see. Add it again from the
    other client's page if it belongs on the portal there.

  The client's people then no longer see it, and secure links no longer give it. History says
  **Removed a file**, by **Vibe Files' B2**, and **Settings › Storage** says how many files
  were removed this way in the last 7 days. The portal waits until a second look finds the
  document still gone, so it takes 10 to 20 minutes. If it was a mistake, put the document
  back in Vibe Files and push; once the client's list shows it again, press **Add to portal**
  and choose again who sees it. Nothing is removed while the portal cannot read the bucket,
  or when a client is no longer in the bucket at all.
- Only documents added with **Add to portal** follow B2. One shared from Vibe Files changes on
  the portal when someone shares it again from Vibe Files, as before.
- If Vibe Files' sync key is ever changed, **Add to portal** says so: enter the passphrase
  again under **Settings › Storage**.

## Storing files in Backblaze B2 (optional)

Shared files and client uploads are kept on the appliance unless you move them to a B2 bucket.
They are encrypted on the appliance first, so B2 only ever holds files it cannot read.

1. In Backblaze, make a **private bucket for the portal alone**, without Object Lock, and an
   **application key** limited to that bucket that may read, write, list and delete files. (The
   bucket Vibe Files' B2 sync uses will do as well, if it has no Object Lock: each keeps to its
   own folders in it. See **Adding a document in B2 to the portal from the staff page**.)
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

## Staff sign-in with Vibe Auth (optional)

Vibe Auth is the appliance's single sign-on. When it is installed, the appliance console
registers the portal with it, gives the portal its settings and restarts it. Until an admin
turns it on, staff sign in with their email, password and authenticator code as before.

To turn it on, an admin opens **Settings › Sign-in with Vibe Auth** on the staff page, picks
Sign-in mode **both** and saves. Then:

- The staff sign-in page shows **Sign in with** and the firm's Vibe Auth name. Staff passwords
  still work beside it.
- **Who gets in**: anyone with a Vibe Auth account. The first time someone signs in, a staff
  account is made for them with their Vibe Auth email. It sees every client; an admin can limit
  it on Settings › Staff › Access, as for anyone else. Someone who already has a staff account
  with the same email is joined to it.
- **Who is an admin**: Vibe Auth's groups decide, at every sign-in. Members of vibe-admin,
  vibe-it or vibe-partner are admins; vibe-manager, vibe-staff and everyone else are staff.
  The portal never takes admin away from its last admin.
- **The second step**: Vibe Auth asks for it (its own authenticator setup), so the portal does
  not ask for another code.
- **Signing out** of the staff page also signs out of Vibe Auth. Signing out of Vibe Auth
  elsewhere, or an IT person ending the session there, ends the portal session within seconds.

An admin chooses how staff sign in under **Sign-in mode** on **Settings › Sign-in with Vibe Auth**:

| Sign-in mode | What staff see                                 |
| ------------ | ---------------------------------------------- |
| local        | No Vibe Auth button (the default)              |
| both         | The button, and the password sign-in under it  |
| oidc_only    | Only the button. A password sign-in is refused |

**oidc_only** needs two things first: a successful **Test connection** on that page, and the
emergency account (`vibe-breakglass`) the appliance makes when it registers the portal. Its
password is kept by the appliance console. If Vibe Auth is ever down, open
`https://files.yourfirm.com/staff/login?local=1` and sign in with the email
`vibe-breakglass@vibe-auth.local` and that password; it needs no authenticator code. The portal
refuses to start in oidc_only without that account, so the firm is never locked out.

**Test connection** asks Vibe Auth for a fresh sign-in, so you are asked for your password and
authenticator code again; you stay signed in to the staff page, and oidc_only can be chosen
for the next hour. It needs Vibe Auth 1.0.21 or later (the appliance's Vibe Auth updates to
it): on 1.0.19 it ends on a "Not Found" page, and on 1.0.20 it signs out an admin who signed in
through Vibe Auth.

If Vibe Auth cannot be reached when the portal starts, the portal still starts; the button says
Vibe Auth cannot be reached, and password sign-in (when allowed) works as usual.

To make the emergency account by hand, on the appliance:

```sh
sudo docker exec vibe-files-portal node_modules/.bin/tsx node_modules/@kisaesdevlab/vibe-auth/dist/cli.js breakglass ensure --json
```

It prints the password once. `breakglass status`, `rotate` and `verify` work too.

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

## People on the portal

Staff who see every client have **People** on the staff page: everyone who can sign in, with the
clients each can see. Find a person by name, email or mobile number, and open them:

- **Details**: their name, and how new files are announced to them. Their email or mobile number
  is changed with **Change**: a link goes to the new one, and it is used only once they open it
  and press Confirm, so a mistyped address lets nobody in. Until then the page shows it waiting,
  with **Withdraw**. When they confirm, they are signed out, and the old address or number is told
  it was changed. **Remove** takes a mobile number away (they keep signing in by email).
- **Clients**: **Add a client** gives them access at once and tells them by email or text.
  **Find a client** above the list narrows it by name or client ID (0.3.19).
  **Remove** takes it away at once. On a client's page, a person's name opens their page too.
- **Account**: **Send sign-in link** emails them a link (by text if they have only a number) that
  signs them in once, within 24 hours: for someone who cannot manage signing in. **Turn account
  off** signs them out everywhere and stops them signing in to any client, and withdraws
  invitations waiting for them; their clients and history are kept for **Turn account on**.
- **Activity**: what they did and what staff did about them, newest first, with the client each
  was on.

## A link at the top of a client's portal

A client can have its own link from another service (for example, to pay an invoice or book a
meeting), shown at the top of their portal as a short message and a button that opens the link
in a new tab. Any staff member can set it for the clients they see.

- **One client:** on the client's page, **Link on the portal** > **Add a link** (or **Change**,
  **Remove**). Enter the message, the button text (Open if empty) and the URL. The preview shows
  how it looks.
- **Many clients:** on **Clients**, **Portal links from a CSV…**. The file needs a header row
  with `client_code` and/or `client_name`, `url`, `message` and, if you like, `button`:

  ```
  client_code,client_name,url,message,button
  SMIJ01,"Smith, John",https://pay.example.com/c/8f2a,Your invoice is ready.,Pay now
  ```

  Rows are matched by client code first, then by name. Choosing the file only checks it: the
  table says what each row would do, and nothing changes until **Apply**. A row replaces that
  client's link; a row with no URL removes it. **Download the current links** gives the same
  format, to edit in a spreadsheet and upload again.

Links must start with `https://` (or `http://`).

## Seeing a client's portal as they do

On a client's page, **See this client’s portal as they do** opens their portal in a new tab, read
only: the same page they see, with their link and their files. Each person sees only the files
shared with them, so the preview lists the files someone at the client can see. PDFs and pictures
open; nothing downloads, and opening a file here does not count as the client having seen it (it
is in History as yours).

To see it as **one person** does, press **View as** beside them under **People with access**, on
the person's own page beside each of their clients (0.3.20), or choose them under **View as**
at the top of the preview. The preview then lists only the files
shared with that person, each marked **New** where they have not opened it yet. It is still read
only, and opening a file there still does not count as their opening it. What the person sent to
the firm is not shown there (it is on the client's page, under its uploads). Someone whose
account is turned off has no **View as**: they sign in to nothing.

## An invitation that was not accepted

On a client's page, under **People with access**, an invitation still waiting has two buttons.
**Resend** sends a new invitation to the same email or number: a new link, good for 7 days, and
the link sent before stops working. **Delete** takes the invitation away, and its link stops
working. Both ask first. An invitation that expired stays listed until it is resent or deleted.

**When their email does not arrive (0.3.20).** Some mail systems block the portal's messages.
**Copy link** on a waiting invitation (and **Copy a link instead** in the invite form) makes a
new invitation without sending anything, and shows its link once for you to copy and pass on
yourself: by text, or to another address of theirs. The link they had before stops working.
It works once, for 7 days. **Whoever opens the link gets that person's access**, so give it
only to them; unlike the emailed one, it does not show that the address is theirs. The link is
not kept where it can be read again: once the box is closed, make a new one.

**Files for someone who has not accepted yet.** Under **Files on the portal**, tick the files,
and in the bar that appears tick the invited person under **For:** (their name, with
**(invited)**; everyone is ticked to start with, so untick anyone the files are not for), then
press **Show to them**. An invitation that expired is listed as **(invitation expired)** and is
not ticked: resend it first, or the files reach nobody. The file's row then says it is chosen for them.
They are told nothing of the files then; when they accept the invitation, the files are on their
page at once, marked **New**, with no further email. To tell them files are waiting, press
**Resend** after choosing: the new invitation, when it goes by email, adds the line "Files are
waiting for you there." (no file names; a text message has no room for it). History names who a
file was chosen for, as invited and not accepted yet. All this needs Vibe Portal 0.3.19. The choices follow a **Resend**; **Delete** drops them, and a file
removed from the portal meanwhile is left out.

**People** lists only those who can sign in, so someone invited is not among them until they
accept. Below the list, **Invited, not accepted yet** names each invitation still waiting and
its client.

**Someone invited has a page of their own** (0.3.20): press their name there. It lists every
invitation waiting for that email or number, one for each client, with **Resend** and
**Delete**, and **Add a client**, which invites them to another client (they get an invitation
for it too). **Accepting any one invitation accepts every one still waiting for them**, so one
link is enough to see all their clients. Files are chosen for them on each client's page. If
they already sign in to the portal with that email or number, the page says so and links to
their account: accepting adds the clients to it, and no second account is made.

**Inviting someone who already has an account.** The portal knows a person by the email (or
number) the invitation goes to. If they already see this client, the form says so; if their
account is turned off, it says to turn it on first; otherwise accepting adds this client to
the account they have, and they choose between their clients at the top of their page. For
someone who already has an account, **People › (the person) › Add a client** gives access at
once, without an invitation. An invitation to a different email than the one they sign in with
makes a second, separate account.

## When something is wrong

| What you see                                                                 | What to check                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare 502 on the portal address                                         | **No TLS Verify** on the tunnel's public hostname (step 3)                                                                                                                              |
| Clients get no email                                                         | `sudo vibe logs portal` for the SMTP error; the mailbox may need SMTP AUTH turned on (Office 365: Admin center › user › Mail › Manage email apps)                                       |
| The staff page shows no documents in B2 for a client                         | In Vibe Files, **Admin › Portal**: is **Show the documents in B2 on the portal's staff page** ticked? Is Vibe Files (0.1.38 or later) open on the computer B2 sync runs on? Is B2 sync set up and unlocked there, and has it synced since? Lists go about every 10 minutes. A document held back by **What goes to B2** is not listed. Vibe Files says so in Browse when the portal is too old for the list |
| Vibe Files' **Test** says the key is not accepted                            | The key was revoked or mistyped: make a new one on the staff page                                                                                                                       |
| Uploads do not arrive                                                        | Is Vibe Files open on some PC? In Admin › Portal press **Fetch uploads now**; a problem shows in the bar at the top of Browse. The staff page's **Uploads** lists what is still waiting |
| Staff locked out after wrong tries                                           | Wait 15 minutes. Lost phone: an admin sends **New setup link**, or `sudo vibe portal staff-reset <email>`                                                                               |
| No admin can sign in (left the firm, lost phone)                             | `sudo vibe portal staff-reset <email> --admin` for a staff member: they get a new setup link and become an admin                                                                        |
| A staff member does not see a client, or has no **Requests** or **Settings** | An admin limited them: Settings › Staff › **Access**                                                                                                                                    |
| Someone sent a secure link gets no access code                               | Their spam folder. One code a minute and ten a day per link. `sudo vibe logs portal` for the SMTP error                                                                                 |
| Someone sent a secure link sees **Access locked**                            | 15 wrong codes ended the link: send a new one from the client's page                                                                                                                    |
| A secure link went without the watermark on a PDF | The PDF is locked with a password, damaged or over 30 MB, so it was sent as it is; the page named it when the link was sent. From Vibe Files such a PDF is refused instead: send it without the watermark, or share an unlocked copy |
