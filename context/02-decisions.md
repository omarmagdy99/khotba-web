# Decisions already agreed with the client

These are settled. Do not reopen them, do not propose alternatives, do not "improve" on
them. Where a decision looks suboptimal, the trade-off was already discussed and accepted.

## Architecture

```
GitHub Pages (static HTML/CSS/JS)  →  Google Apps Script Web App  →  Google Sheets
        the UI                            the API + rules              the data
```

- **No build step, no framework, no npm.** Plain HTML/CSS/JS files served by GitHub Pages.
  The client edits and publishes these directly.
- **Google Sheets is the database.** Non-negotiable — the staff must be able to open the
  sheet and read it directly if the site is ever down.
- **Apps Script is the only thing that talks to the sheet.** No Google API keys in the
  frontend; a static site cannot hold a secret.
- **The client already has a working Apps Script deployment** feeding the reference page
  (see `context/reference-public-page.html`). That proves the approach; the new script
  replaces it.

## Data model — the central change

**Stop using one column per Friday. Use one row per assignment.**

```
date        | mosque_id | khatib_id | status
2026-07-31  | M001      | K042      | confirmed
2026-07-31  | M002      | K017      | confirmed
```

Adding a Friday means adding rows. The sheet's shape never changes. This single change
removes most of the defects listed in `01-current-system.md`.

**Join on IDs, never on names.** A khatib's name must be editable without breaking history.

### Proposed tabs

| Tab | Purpose |
| --- | --- |
| `mosques` | id, name, mujawra, address, permanent_khatib_id, active |
| `khatibs` | id, name, phone, type, notes, active |
| `preferences` | khatib_id, mosque_id — mosques this khatib wants to serve |
| `assignments` | id, date, mosque_id, khatib_id, status, updated_by, updated_at |
| `users` | admin accounts |
| `settings` | which date range is published to the public page |

Column names above are a starting point, not a mandate — refine them if there is a concrete
reason, and say so in the report.

## Rules

- **A khatib cannot be assigned to two mosques on the same date.** This is the one hard
  business rule. It must be enforced **server-side in Apps Script**, not only in the UI.
  Use `LockService` so two admins saving at once cannot both slip past the check.
- **`أساسي` (primary) vs `متطوع` (volunteer) is a label only.** The client confirmed
  explicitly: **no difference in scheduling rules.** Display it, filter by it, nothing more.
- **A mosque may have a permanent khatib.** Set on the mosque record. When an admin
  generates a new Friday, every mosque with a permanent khatib is pre-filled; the rest are
  left blank and visibly flagged. The pre-filled value stays editable — a permanent khatib
  can travel or fall ill.
- **A khatib cannot be permanent for two mosques.** Block it at entry time.

## Users

- **Multiple staff members**, not one shared login. Each has their own account.
- Every assignment records **who changed it and when**.
- If two admins open the same Friday, the second to save is warned rather than silently
  overwriting.

## Data migration

- **Start fresh from the next upcoming Friday.** Do not import the historical assignment
  grid — it is corrupted (see defects 3, 4, 5). The old sheet stays as a read-only archive.
- **Import mosques and khatibs only**: 85 mosque records, 127 khatib records.
- **Phone numbers do not exist and will be typed in by hand.** The khatib screen must make
  it obvious which records are still missing a number.

## Public page

- The audience is roughly **160 people — mostly the khatibs themselves**, not the general
  public. Traffic is negligible; Apps Script quota is not a concern and needs no caching or
  static-JSON layer. The client explicitly ruled this out as a worry.
- An admin controls **which dates are visible** to the public.
- It must look and behave like `context/reference-public-page.html` — see
  `03-reference-page.md`.

## Language and locale

- **Arabic, RTL, throughout.** `dir="rtl"` `lang="ar"`.
- **Mobile-first.** Khatibs will open this on phones.
- Gregorian dates. Fridays only.
