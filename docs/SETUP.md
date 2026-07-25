# Setup

Written for someone who has not done this before. Follow it in order.

## 1. Create the spreadsheet and run `setup`

1. At [sheets.new](https://sheets.new), create a spreadsheet named `أوقاف 15 مايو — الخطب`.
2. **Extensions → Apps Script**. This creates a *bound* project, which is what you want —
   `SpreadsheetApp.getActive()` then resolves without an ID.
3. Rename the project `أوقاف 15 مايو — API`.
4. Delete the placeholder `myFunction`, paste the whole of `apps-script/Code.gs`, and save.
5. Pick **`setup`** from the function dropdown at the top and press **Run**. Authorise when
   Google asks.

`setup` creates all seven tabs with their headers, applies plain-text formatting to every
column that needs it, hides `users` and `sessions`, seeds the ID counters and the publish
window, and removes the empty default sheet.

It is safe to run again. It skips any tab that already exists and never touches data.

**Do not create the tabs by hand.** The plain-text formatting is the part that matters, and
it cannot be applied retroactively — `01001234567` would already have become `1001234567`.

## 2. Seed the data

With the tabs in place, **File → Import → Upload**. Import each CSV with
**Append to current sheet**, having first clicked into the matching tab:

| File | Tab | Rows |
| --- | --- | --- |
| `context/mosques.csv` | `mosques` | 85 |
| `context/khatibs.csv` | `khatibs` | 131 |
| `context/preferences.csv` | `preferences` | 2,458 |

All three are UTF-8 with a BOM so Sheets detects Arabic correctly. If names arrive as
`Ø£Ø­Ù…Ø¯`, the encoding was overridden — undo and retry, choosing UTF-8 explicitly.

Then fill the columns the CSVs do not carry: `active` = `TRUE` and `created_at` for every
mosque and khatib row, and `type` for every khatib (`primary` or `volunteer`).

Spot-check five khatib names against the CSV. Trailing spaces were stripped during export; if
any reappear, the import re-added them and search will misbehave later.

## 3. Create the admin accounts

Passwords are stored salted and hashed, so they cannot be typed into the sheet directly.
`Code.gs` already contains a `createUser` function for this.

Edit the three constants at the top of it, run it, and repeat for each staff member:

```js
var username    = 'fatma';
var displayName = 'فاطمة عبد الله';
var password    = 'CHANGE-ME';
```

It refuses to run while the password is still `CHANGE-ME`. Blank the values again when you
are done, and never commit a real password.

## 4. Optional: nightly session cleanup

**Triggers → Add trigger →** function `purgeSessions`, time-driven, day timer. Not required —
expired tokens are rejected whether or not the row still exists — it just keeps the tab small.

## 5. Deploy as a Web App

1. **Deploy → New deployment**.
2. Gear icon → **Web app**.
3. Set:
   - **Description:** `v1`
   - **Execute as:** `Me` — the script needs your access to the sheet; the visitor has none.
   - **Who has access:** `Anyone` — required for an anonymous public page. Note this means
     **anyone with the URL can call the endpoint**, which is exactly why every write action
     checks the token first.
4. **Deploy**, then authorise. Google will warn that the app is unverified: **Advanced → Go to
   … (unsafe)**. This is expected for your own script.
5. Copy the **Web app URL**. It ends in `/exec`.

## 6. Redeploying after a code change — read this before your first edit

Saving the script does **not** update the live Web App.

- **Deploy → Manage deployments →** pencil icon **→ Version: New version → Deploy.**
  This keeps the same URL.
- **Do not** use *New deployment* for an update. It mints a **new URL** and leaves the old one
  serving stale code, which presents as "my fix did nothing".

## 7. The frontend

Repository layout:

```
index.html          login
mosques.html
khatibs.html
schedule.html
publish.html
public.html         the public schedule
assets/app.js       shared: fetch wrapper, auth, normalizeText
assets/style.css
config.js           the deployment URL
```

`config.js`:

```js
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfyc.../exec';
```

Kept separate so a redeploy touches one line in one file.

**This URL is public** — it ships in the browser. That is fine and unavoidable for a static
site; it is not a secret, which is why authorisation lives in the script.

## 8. Enable GitHub Pages

1. Push to GitHub.
2. **Settings → Pages → Source: Deploy from a branch →** `main`, folder `/ (root)` → **Save**.
3. Wait a minute; the URL appears on the same page.

`.nojekyll` at the repository root is not strictly required here, but add it — Jekyll ignores
directories beginning with an underscore, and it costs nothing to rule out.

## 9. Verify end to end

In order. Each step catches a different failure.

1. Open the Web App URL directly in a browser. JSON, not an error page → the deployment works.
2. Open the GitHub Pages login and sign in. Success → **CORS works**, the riskiest assumption
   confirmed.
3. Add a test mosque, confirm the row appears in the sheet, delete the row.
4. Generate a Friday, confirm 85 `assignments` rows appear.
5. Assign one khatib to two mosques on the same date → must be refused.
6. Publish a range and open the public page in a private window — no login, correct data.
7. Open the public page on a phone.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Failed to fetch`, CORS error in console | A custom header or `Content-Type: application/json` on the POST. Use `text/plain;charset=utf-8` and no other headers — see `API.md`. |
| Fix has no effect | Deployed as a new deployment instead of a new version. Check the URL. |
| Phone numbers lost a leading zero | Column was not plain text before import. Reformat and re-import. |
| Dates off by one day | Dates stored as Sheets dates rather than text. |
| `Authorization is required` | Script was edited to use a new service; re-authorise via **Deploy**. |
| Arabic appears as `Ø£Ø­Ù…Ø¯` | Import encoding was not UTF-8. |
