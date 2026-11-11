# Zarzis Portes – Shared Room

A small file-sharing room for the office network. Staff sign in with Google, pick a nickname,
drop files in, and a live **Scoreboard** records who uploaded, replaced or deleted what, and when.
Excel, Word and text files can be **edited right inside the app** (editor on the right), and the **Chief** of the room hands out
Discord-style **roles** (list of people on the left) that decide who may view, download, add, modify or delete files,
and can protect individual files. Works on **Windows and Mac** (the server can run on either; staff can use any browser on any system).

```
zarzis-portes-share/
├── server.js              Express server: API, uploads, downloads, HTTPS
├── package.json           3 dependencies: express, cookie-session, selfsigned
├── .env.example           copy to ".env" and fill in
├── start-server.bat       Windows: double-click to start
├── start-server.command   Mac: double-click to start
├── src/
│   ├── config.js          reads .env, allowed-email rules
│   ├── auth.js            "Sign in with Google" (OAuth 2.0 code flow)
│   ├── permissions.js     roles, permissions, per-file protection
│   ├── edit-routes.js     in-app editing API (locks, saves, new files)
│   ├── xlsx.js            reads/edits Excel files cell by cell
│   ├── docx.js            reads/edits Word text paragraph by paragraph
│   ├── db.js              JSON database (users, files, activity log)
│   └── util.js            file-name cleaning, CSV, safe preview types
├── public/
│   ├── index.html         login, nickname prompt, room, scoreboard
│   ├── css/style.css
│   └── js/            app · members (left board) · editor (right pane)
│                      sheet · docxedit · textedit · formula · admin · util
├── test/                  npm test (permissions, formulas, Excel/Word modules)
└── data/                  created automatically (see "Where is everything?")
```

(`src/session-store.js` is left over from an earlier attempt and is not used.)

---

## 1. Install Node.js (once, on the server computer)

Go to <https://nodejs.org>, download the **LTS** version (20 or newer) and install it with the defaults
(Windows `.msi` or Mac `.pkg`; Mac with Homebrew: `brew install node`).

The first time you start the server it installs its 4 packages by itself (internet needed, about a minute).
To do it by hand instead: open a terminal in the project folder (Windows: click the folder's address bar, type `cmd`,
Enter · Mac: right-click the folder → *New Terminal at Folder*) and run `npm install`.

## 2. Decide the address staff will use  ⚠️ important

Google **does not accept** `http://192.168.x.x:3000` for sign-in. It only accepts
`https://` addresses with a real domain name (or plain `localhost` on the same PC).
So the office needs a *name* that points to the server PC. Pick one:

| Option | Setup | Address example |
|---|---|---|
| **A. A domain you own** (best for permanent use) | In your DNS (or the router's local DNS) add a record `files.yourdomain.com → 192.168.1.50` | `https://files.yourdomain.com:3443` |
| **B. sslip.io** (quickest, no purchase) | Nothing. `192-168-1-50.sslip.io` automatically resolves to 192.168.1.50 | `https://192-168-1-50.sslip.io:3443` |
| **C. hosts file** | On every computer add the line `192.168.1.50  files.yourdomain.com` to the hosts file – Windows: `C:\Windows\System32\drivers\etc\hosts` (open Notepad as administrator); Mac: `sudo nano /etc/hosts` in Terminal | `https://files.yourdomain.com:3443` |
| **D. Test on the server PC only** | Nothing | `http://localhost:3000` |

Notes: some routers block public names that point to private IPs ("DNS rebinding protection") – if B
fails for that reason, use A or C. Give the server PC a **fixed IP** (reserve it in the router) so the
address never changes. Option B is widely used but is a third-party service and not guaranteed by Google –
if Google rejects it in the console, use A or C.

Because the server makes its own security certificate, each browser shows a warning the **first time**
("Your connection is not private"). Click **Advanced → Continue to…**. Once per browser.

## 3. Create the Google sign-in (≈10 minutes, free)

1. Open <https://console.cloud.google.com> and sign in with the company Gmail.
2. Top bar → project picker → **New project** → name it `Zarzis Portes Shared Room` → **Create**.
3. Menu → **APIs & Services → OAuth consent screen** (may be called *Google Auth Platform*).
   - **Get started** → App name `Zarzis Portes Shared Room`, support email = yours.
   - Audience: **External**. Contact email = yours. Accept and **Create**.
   - Keep the app in **Testing** mode. Under **Audience → Test users → Add users**, add every
     staff Gmail address (up to 100). Only these people can sign in – a second layer of protection
     in addition to `ALLOWED_EMAILS` below.
4. **Clients** (or *Credentials → Create credentials → OAuth client ID*):
   - Application type: **Web application**, name `Shared Room`.
   - **Authorized redirect URIs → Add URI**: your address from step 2 followed by `/auth/google/callback`, e.g.
     `https://192-168-1-50.sslip.io:3443/auth/google/callback`
     (for option D: `http://localhost:3000/auth/google/callback`)
   - **Create**. Copy the **Client ID** and **Client secret**.
   - Leave "Authorized JavaScript origins" empty – not needed.

> In Testing mode Google signs people out of the app's Google permission every 7 days, but the
> Shared Room keeps its own 30-day login, so staff are not bothered. If you ever exceed 100 people,
> publish the app (basic scopes `openid email profile` need no Google review).

## 4. Configure and run

1. Copy `.env.example` to `.env` (Windows: copy the file and rename it to exactly `.env`).
2. Fill in:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   BASE_URL=https://192-168-1-50.sslip.io:3443
   ALLOWED_EMAILS=maria@gmail.com,john@gmail.com,...
   ```
   `BASE_URL` must match the redirect URI from step 3 exactly (without `/auth/google/callback`).
3. Start the server and keep its window open (it prints the staff address and any problems):
   - **Windows:** double-click **start-server.bat**.
   - **Mac:** double-click **start-server.command**. The first time, macOS may refuse because the file was downloaded:
     right-click it → **Open** → **Open**. (If it says it has no permission, run `chmod +x start-server.command` once in Terminal.)
   - Either system: `npm start` in a terminal.
4. **Allow it through the firewall.**
   - Windows asks the first time – tick *Private networks* → Allow. If it did not ask: Windows Security → Firewall → Allow an app, or add an inbound rule for TCP port 3443.
   - Mac asks *"Do you want the application “node” to accept incoming network connections?"* → **Allow**. (If you missed it: System Settings → Network → Firewall → Options → add *node*.)
5. On any office PC open the address from `BASE_URL`, accept the certificate warning once, press
   **Sign in with Google**, choose a nickname. Done.

**Keep the server computer awake.** The room is unreachable while that computer sleeps.
Windows: Settings → System → Power → Sleep → *Never* (when plugged in). Mac: `start-server.command` already prevents sleep while it runs
(and System Settings → Battery/Energy → *Prevent automatic sleeping when the display is off* for laptops/desktops that ignore it).

**Start automatically at login.** Windows: press `Win+R`, type `shell:startup`, put a shortcut to `start-server.bat` there.
Mac: System Settings → General → Login Items → **+** → choose `start-server.command`.

## 5. Roles and file permissions (the Chief)

**Who is the Chief?** The emails in `CHIEF_EMAILS` (in `.env`). If you leave it empty, the first person to sign in becomes Chief.
The Chief can also make other people Chief. Only the Chief sees the **Manage roles** button and the **Access** button on files.

**The left board (like Discord).** Top card: *your* name in your role colour, your roles and a ✓/✕ list of what you may do.
Below it, everybody in the room grouped by their highest role (Chief first), with a green dot for people online now.
**The Chief clicks a name** to tick or untick roles for that person – saved immediately.

**Each role has five switches:** **View files**, **Download files**, **Add new files**, **Modify files** (edit in the app / replace),
**Delete files**. Create roles and colours under *Manage roles → Roles*.

**How permissions combine (same as Discord):**
- Everybody is automatically a **Member**, and a person gets the **combined** powers of Member + all their other roles.
  So to make the room restricted, first untick things on the *Member* role, then give extra powers through other roles
  (e.g. Member = view only; *Accounting* = view + download + add + modify).
- Without **View** a person sees no files at all. Without **Download** they can still read a file in the editor/preview but cannot save a copy.
- **Protect one file:** click **Access** next to a file and tick the roles allowed to edit it. From then on **only those roles
  (and the Chief)** can modify or delete that file – even if general permissions would allow it. Everyone with *View* still sees it.
- People without permission see *Read only for you*, no Delete button, and refused uploads show a clear message.
- Every role change, assignment and file protection appears on the Scoreboard as **Access changed** (and in the CSV).

**Room chat.** Under the list of people there is a small chat box. Type and press **Enter** to send (Shift+Enter for a new line). Every message shows the sender's nickname in their role colour with their role next to it, and appears for everyone within a few seconds. You can delete your own messages with the **×**; the Chief can delete anyone's. The newest 300 messages are kept, and a person can send at most 20 per minute.

## 6. Editing files inside the app

**Rename:** the **Rename** button next to a file (needs the *Modify* permission, or the right role on a protected file). If you leave out the extension it is kept (“Budget” stays “Budget.xlsx”). A name that already exists is refused, and nobody can rename a file while someone else is editing it. The Scoreboard shows *Renamed · Was “old name”*.

**More Excel sheets:** press the **+** at the end of the sheet tabs, type a name (max 31 characters, no `[ ] : * ? / \`) and Enter. The new sheet appears for everyone within a few seconds. Sheets can be added but not yet renamed, moved or deleted in the app.

**Trash can:** the **🗑 Trash** button above the file list (Chief and anyone with the *Delete* permission). It holds deleted files **and** the older versions made when a file was replaced or edited, for `TRASH_DAYS` days (30 by default). **Restore** puts a deleted file back; if a file with that name exists now it is *not* overwritten – the copy comes back as “name (restored).ext”. Restoring an older version makes it the current file and keeps the version it replaced in the trash, so a restore can be undone too. Only the Chief sees **Delete forever**. Limitation: a deleted file loses its per-file *Access* restriction, so the Chief must set it again after restoring.

Press **Edit** next to a file (or click its name). The editor opens on the right (full-screen on small screens).
**+ New file** creates an empty spreadsheet (3 tabs), Word document or text file.

| File type | What you can do | Several people at once? |
|---|---|---|
| **Excel** `.xlsx` `.xlsm` | Click a cell and type; Enter/Tab/arrows to move; `=` formulas (SUM, AVERAGE, IF, ROUND, … the common ones); paste blocks from Excel; Delete clears; switch tabs at the bottom. **Saves automatically** a moment after you stop typing. | **Yes.** Only the cells you change are written into the current file, so different people's cells never overwrite each other. Others see your changes within a few seconds. |
| **Word** `.docx` `.docm` | Edit the **text** of paragraphs, add (`+` or Enter at the end) and delete paragraphs; press **Save** (or Ctrl+S). | One editor at a time – others see "Maria is editing" and read along. |
| **Text** `.txt .md .csv .json .log .xml .ini .tsv` | Plain text editor; **Save** or Ctrl+S. | One editor at a time. |

**What stays safe:** the app edits *inside* the file and changes only what you touched. Charts, pictures, macros, styles, column widths,
other tabs, Word tables/headers/page layout are left exactly as they were. Word paragraphs that contain pictures, links, fields, page
breaks or tracked changes show a 🔒 and are read-only (change those in Word). Before a save, the previous version is kept in `data/trash`
(at most one safety copy per 10 minutes while you are typing).

**Limits you should know:**
- Excel formulas are calculated in the browser for the common functions. Formulas using other functions (e.g. VLOOKUP) keep the value Excel last stored
  and are recalculated by Excel the next time the file is opened there. Cells that belong to *shared/array formulas* are read-only (edit them in Excel).
- Only the first 3000 rows × 100 columns of a sheet are shown. No cell merging/colour/number-format *editing* – the existing look is preserved, not changed.
- In Word, edited paragraphs keep the paragraph style and the font of their first word; formatting that varies *inside* an edited paragraph (e.g. one bold word) is flattened to the first style.
- Old binary formats (`.xls`, `.doc`) cannot be edited in the app – download them or save them as `.xlsx` / `.docx` first.
- Many quick saves by the same person appear as **one** Scoreboard line ("Edited in the app · 7 saves").

## 7. Using it

- **Upload:** drag files anywhere on the page, or **Choose files…**. Any file type, up to 200 MB each.
- **Replace:** upload a file with the same name (capital letters don't matter) and everyone now has the new one (if their role allows it).
  The Scoreboard shows **Updated** instead of **Uploaded**.
- **Open:** click a file name. Excel/Word/text open in the editor, PDFs and images in a viewer. **Delete** asks for confirmation.
- **Scoreboard:** refreshes by itself every few seconds; shows time (your PC's clock zone), nickname + Google email,
  action and file. **Export CSV** saves the entire history for audits.
- Folders cannot be uploaded – zip them first.

## Where is everything?

```
data/shared-files/    the current files, with their real names
data/trash/           the previous version of every replaced file + every deleted file (kept 30 days)
data/db.json          users, nicknames, file list and the full activity log (+ db.json.bak)
data/certs/           the generated HTTPS certificate
data/session-secret.txt  keeps logins valid across restarts – keep private
```
**Back up the `data` folder** (copy it to an external drive regularly). To restore an old version of a
file, copy it from `data/trash/` and upload it again (remove the timestamp prefix from the name).

## Settings (`.env`)

| Setting | Meaning |
|---|---|
| `ALLOWED_EMAILS` | Comma-separated emails allowed to sign in. Empty = any Google account that can reach the server. |
| `ALLOWED_DOMAINS` | Optional, e.g. `zarzisportes.com` for Google Workspace accounts. |
| `CHIEF_EMAILS` | Comma-separated Chiefs (always Chief; empty = first person to sign in). |
| `MAX_UPLOAD_MB` | Largest file (default 200). |
| `TRASH_DAYS` | How long old versions / deleted files are kept (default 30, `0` = forever). |
| `PORT`, `DATA_DIR` | Override listening port / data folder. |
| `SSL_KEY_FILE`, `SSL_CERT_FILE` | Use your own certificate (e.g. from Let's Encrypt) to remove the browser warning. |

## Troubleshooting

- **`Error 400: redirect_uri_mismatch`** – the redirect URI in Google Cloud differs from `BASE_URL + /auth/google/callback`. Compare character by character (https, port, no trailing slash).
- **`Error 403: access_denied`** – the person isn't in *Test users* (step 3.3).
- **"This Google account is not on the list"** – add the address to `ALLOWED_EMAILS`, restart the server.
- **Other PCs can't open the page** – firewall (step 4), wrong IP, or the name doesn't resolve (`ping your-name` from that PC should show the server's IP).
- **Sign-in loops / "took too long"** – open the site using exactly the `BASE_URL` address (the server redirects other addresses automatically).
- **"Google could not sign you in"** – the server PC needs internet access to talk to Google; check the server window for the reason.
- **Port in use** – another copy is running; close it.

## Security notes

- Anyone who can sign in can see and download every file; what they may change is set by roles. The Scoreboard shows who did what, and replaced/deleted files stay recoverable in `data/trash`.
- Keep `.env` and `data/session-secret.txt` private (they are excluded by `.gitignore`).
- Only PDFs, images and plain text are displayed in the browser; everything else is forced to download.
- This is meant for a trusted office network – don't expose the port to the internet.
