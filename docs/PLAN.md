# Implementation plan

Replace the Awqaf office's single overloaded Google Sheet with a Sheets-backed web app:
Google Sheets as the database, Apps Script as the API, static Arabic RTL pages on GitHub
Pages as the UI.

Read `context/01-current-system.md` for what is being replaced and why, and
`context/02-decisions.md` for the decisions that are already settled.

## Phases

Ordered by dependency. Each phase ends at a state you can demonstrate.

### Phase 0 — Spreadsheet and seed data

Create the spreadsheet with the seven tabs from `DATA-MODEL.md`. Format `phone`, every `id`,
and every date column as **plain text before importing anything** — this is the step that is
easy to skip and expensive to undo, because Sheets will strip the leading zero from
`01001234567` and reinterpret `2026-07-31` by locale.

Import `context/mosques.csv` (85 rows), `context/khatibs.csv` (131 rows), and
`context/preferences.csv` (2,458 rows). Create one admin account per staff member.

The preferences were recovered from the old sheet's khatib tab, where each khatib's chosen
mosques were picked from dropdowns. Every one of the 2,458 labels resolved to a known mosque —
zero unmatched.

**Done when:** all seven tabs exist, 85 mosques and 131 khatibs are present, and a spot-check of
five khatib names matches the CSV exactly — no trailing spaces, no mangled Arabic.

### Phase 1 — API core

The Apps Script project: the request envelope, `login` / `logout` / `whoami`, and the read
actions. Deploy as a Web App and confirm a `fetch` from a GitHub Pages origin actually
returns data.

**Do this before any UI.** The CORS constraint in `API.md` is the single most likely thing to
invalidate the architecture, and it is cheap to test now and expensive to discover later.

**Done when:** a page served from `github.io` can log in and read the mosque list, verified in
a browser, not in the Apps Script editor.

### Phase 2 — Mosques and khatibs screens

Full CRUD for both, plus preferences and the permanent-khatib field with its uniqueness check.

**Done when:** a staff member can add a mosque and a khatib end to end, and the missing-phone
counter on the khatib screen reads 131.

This is also when the phone-number data entry starts — it is 131 manual lookups and it does
not block anything else, so it should run in parallel with Phases 3 and 4.

### Phase 3 — Scheduling

`generateDate`, `saveSchedule` with its lock and its double-booking check, the availability
dropdown, and the remaining-empty counter.

**Done when:** an admin can generate a Friday, see permanent khatibs pre-filled, assign the
rest, be blocked from double-booking someone, and have two browsers editing the same Friday
resolve without either losing work.

The concurrency behaviour must be tested with two actual browser sessions. It cannot be
verified by reading the code.

### Phase 4 — Publishing and the public page

`publishRange`, the public `doGet`, and the public schedule page built on the reference page's
markup.

**Done when:** an admin publishes a range and the public URL shows it with search, the
counter, and PDF export all working on a phone.

### Phase 5 — Parallel run

Run the new system alongside the old sheet for **at least two Fridays**. Staff enter each
Friday in both. Compare the two outputs mosque by mosque before the khutbah, not after.

**Done when:** two consecutive Fridays match exactly and the staff say the new screen is
faster than the sheet.

### Phase 6 — Cutover

Set the old sheet to view-only, announce the public URL, and stop dual entry.

## What must be true before the old sheet is abandoned

Not negotiable:

1. **All 131 phone numbers entered.** The old sheet lost them entirely; if the new system
   launches without them, the office is worse off than before on that one axis.
2. **Every mosque with a standing preacher has `permanent_khatib_id` set.** Otherwise
   `generateDate` fills nothing and every Friday is 85 manual choices.
3. **Two Fridays produced in parallel and matched.**
4. **Every staff member has their own account and has logged in at least once.**
5. **Someone other than the builder has generated and saved a Friday unaided.**
6. **The old sheet is view-only.** Two writable systems means two truths.

## Risks

**Apps Script concurrency.** Two admins saving the same Friday is a real scenario, not a
hypothetical — the office has multiple staff. `LockService` plus the `version` check in
`saveSchedule` handles it, but `LockService` is per-script and serialises *all* writes: under
load, saves queue. At this scale that is invisible. It is called out so nobody later
diagnoses a slow save as a bug.

**The 131 phone numbers.** The largest chunk of pure human effort in the project, and it is
outside anyone's control. Start it in Phase 2 and track it with the on-screen counter. If it
is still incomplete at Phase 5, launch anyway — a missing phone number does not block
scheduling — but do not call the migration finished.

**The first Friday of record.** The first week the new system is the only system is when a
gap becomes a mosque with no preacher at khutbah time. Mitigations: the empty-mosque counter
makes gaps impossible to miss, the parallel run proves the flow first, and the old sheet
stays readable as an archive. Schedule the cutover so the builder is reachable that Friday.

**Apps Script quota.** Documented in `API.md` and judged a non-issue at ~160 readers. The
risk is not today's traffic; it is the schedule being forwarded on WhatsApp beyond the
khatibs. If page loads start failing late in the week, the fix is a `CacheService` wrapper on
`doGet` — one function, not a redesign.

**Sheet growth, which is a separate risk from traffic.** Every read scans the whole
`assignments` tab. At 85 rows per Friday that is ~4,400 rows a year — 22,000 after five. Reads
stay acceptable at that size, but they get slower every year while the office notices nothing
until saves feel sluggish, and a slow read inside the write lock queues everyone behind it.

Do two cheap things rather than one expensive one later:

1. Keep `assignments` sorted by date and locate a date's block by binary search over column B
   instead of loading the tab into memory. The tab is append-only in date order by
   construction.
2. At the end of each year, move rows older than 18 months to an `assignments_archive` tab.
   Nothing reads it; it exists so history is never deleted.

Neither is needed for launch. Both should be written down as scheduled maintenance rather than
discovered as a performance incident.

**Sheet edited by hand.** Staff keep spreadsheet access by design, and an assignment edited
directly bypasses the double-booking check. `DATA-MODEL.md` lists which ranges to protect;
apply that protection in Phase 0 rather than trusting the note.

**Deployment URL rotation.** Redeploying an Apps Script Web App as a *new deployment* changes
the URL and silently breaks the frontend. `SETUP.md` covers updating the existing deployment
instead. Worth reading before the first change, not after.
