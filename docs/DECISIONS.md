# Decisions taken while planning

Decisions made during planning that were **not** already fixed in
`context/02-decisions.md`. One line of rationale each.

## Data model

**Composite assignment id, `{date}_{mosque_id}`.** A mosque has exactly one preacher on one
Friday, so the natural key is already unique. It makes saving an upsert the client can key
without a round-trip, and makes a duplicate row structurally impossible.

**Dates stored as text, not Sheets dates.** Sheets reinterprets date cells by spreadsheet
locale and timezone, and `getValues()` returns an already-shifted JS `Date`. Text removes the
whole class of off-by-one bug.

**Rows are created for every mosque when a Friday is generated, with `khatib_id` empty.**
"Which mosques have nobody?" becomes a filter instead of a diff against the mosque list —
and an unassigned mosque becomes a first-class state rather than an absence.

**Deactivate, never delete.** Deleting a mosque or khatib orphans every historical assignment.

**Added `sessions` and `users` tabs.** `context/02-decisions.md` listed a `users` tab but no
session storage; token auth needs somewhere to keep tokens.

**Split `settings` into key-value rows** rather than fixed columns, so a new setting does not
change the tab's shape.

**`preferences` has no surrogate id.** The `(khatib_id, mosque_id)` pair is the key.

**Booleans as the literal strings `TRUE`/`FALSE`.** A Sheets checkbox returns an empty string
when never touched, which forces null-handling at every read site.

## API

**`Content-Type: text/plain;charset=utf-8` on all POSTs.** Apps Script cannot answer a CORS
preflight, and `application/json` triggers one. The cost is that the auth token travels in
the body and lives in `localStorage`; this is documented in `API.md` rather than hidden.

**HTTP 200 on every response, `ok` in the envelope.** `ContentService` offers no clean way to
set status codes.

**Stale-write detection scoped to touched mosques.** Two admins working on different halves of
the same Friday should both succeed; blocking on any concurrent edit would make the
multi-admin requirement unusable.

**`generateFriday` is idempotent.** Regenerating must never wipe an admin's work — the button
will get clicked twice.

**`setPreferences` replaces the whole list.** The UI is a multi-select and always knows the
complete desired state; incremental add/remove can drift.

**Public `doGet` silently returns empty outside the published window** rather than erroring,
so it cannot be used to probe unpublished drafts.

**Salted SHA-256 for passwords, with the weakness written down.** Apps Script ships no KDF.
Acceptable because the asset is a public prayer schedule, but stated so nobody later assumes
a strength that is not there.

## Screens

**On the khatibs screen, the pill tabs filter by type instead of switching the search field.**
The reference page uses them to choose between two searchable fields; here there is only one,
so the control is reused for the filter the client actually needs.

**A missing-phone counter and filter.** All 127 numbers are being typed by hand; this turns an
invisible backlog into a progress bar.

**Unavailable khatibs are shown greyed and labelled with where they are booked, not hidden.**
An admin hunting for a specific person must be able to see *why* they cannot have them,
otherwise the list looks broken.

**Each khatib's current assignment count is shown in the dropdown.** Not requested. One number
that makes unfair distribution visible at the moment of the decision, computed from data
already loaded.

**Quick buttons for the next four Fridays.** `<input type="date">` cannot restrict by weekday;
validation alone is a worse experience than offering the four dates anyone will actually pick.

**Duplicate names warn but do not block.** Two people can genuinely share a name; the old
sheet's real problem was invisible whitespace, not legitimate duplicates.

**Phone accepted only as 11 digits starting `01`.** Egyptian mobile format. Flag it if the
office also records landlines — this rule would reject them.

## Deliberately out of scope

- **Password reset.** No email sending is planned; an admin re-runs the user-creation snippet.
- **Attendance and substitution tracking.** `status: excused` records that a khatib withdrew,
  but nothing tracks who actually attended. It was not requested, and it changes the office's
  workflow rather than digitising it.
- **Hijri dates.** `الاولي من شوال` in the old sheet shows the office thinks in religious
  events too. Gregorian was decided; a Hijri label per date is an easy later addition.
- **A full audit log.** Assignments carry `updated_by`/`updated_at`, which answers "who
  changed this". A complete change history was not requested.
- **Notifying khatibs.** No SMS or WhatsApp integration.
- **Offline support.**

## Changes made after adversarial review

The plan was reviewed by a second model (Gemini 3.1 Pro) with instructions to attack it. Ten
findings were adopted, one rejected.

**Adopted:**

- `generateFriday` now takes the same lock as `saveSchedule`, with the existence check inside
  it. Without it, two admins clicking `توليد الجمعة` simultaneously both see zero rows and both
  append 85 — 170 rows with duplicate ids.
- Booleans are read through `String(v).toUpperCase() === 'TRUE'`. Sheets stores a `TRUE` cell
  as a real boolean, so the original "compare to the literal string" rule would have marked
  every active record inactive.
- Writes use `setValues()` + `setNumberFormat('@')` rather than `appendRow()`, which can defeat
  the column formatting set up in Phase 0.
- Deactivation now cascades: clears `permanent_khatib_id` references and empties future
  assignments, returning a summary. Previously a deactivated khatib would have kept being
  auto-assigned forever.
- **Non-Friday khutbahs are supported** via `date_type` and `label`. Eid falls on a weekday and
  the old sheet already has a `الاولي من شوال` column — a Friday-only system would have pushed
  that back to paper. This was listed below as an open assumption; the review was right that it
  is severe enough to fix now rather than ask about.
- **A khatib schedule screen was added.** The API defined `getKhatibSchedule` but no screen
  consumed it, which quietly dropped half of what the old sheet does — the `الخطباء` tab exists
  to answer "where am I assigned this month".
- A status control for `معتذر` on the scheduling screen. The enum existed in the data model
  with no way to set it.
- PDF export on the scheduling screen.
- `whoami` and `logout` given full contracts in `API.md`.
- **Every handler wraps in try/catch.** An unhandled Apps Script error returns an HTML page
  with no CORS headers, so a null dereference presents as `Failed to fetch` — debugging goes to
  the wrong layer entirely. This was the most useful thing the review surfaced.

**Rejected — the aggregate `version` check.** The review argued that a single
`max(updated_at)` per date fails to catch a stale write on an individual row, and offered a
worked example. The example has the competing edit happening *before* the reader loaded, which
is not a stale write. Any genuinely competing write happens after the read, and the maximum was
computed from data present at that read, so a later write always exceeds it. The reasoning is
now written into `API.md` along with the two conditions it depends on — server-side timestamps,
and rows created after the read being out of scope.

**Confirmed correct.** All four Apps Script platform claims — no `doOptions`, `text/plain`
avoiding preflight, the `/exec` 302 to `googleusercontent.com`, and `ContentService` having no
status codes — were independently verified.

## Assumptions I had to make — check these

These were genuinely ambiguous. Each one is a guess that could be wrong.

1. **Every mosque holds exactly one Friday khutbah.** The model allows one preacher per mosque
   per date. If any mosque runs two sittings, the composite id has to change — and it is
   cheaper to know now than after data exists.

2. **`مجاورة` is free text, not a fixed list.** Based on the real data mixing `مجاورة 1` with
   `الإسكان العائلي`, `120 فدان`, `دار مصر`, and `المنطقة الصناعية`.

3. **The five names assigned in the old sheet but absent from the khatib roster** —
   `عاطف ابو الفضل` (16 assignments), `عبدالسلام محمود بسيوني`, `أسامة السيد`, `اشرف`,
   `محمد حسن فنتاوي` — are real preachers missing from the list, not typos. They are **not**
   in `context/khatibs.csv`. Someone should confirm and add them; `عاطف ابو الفضل` in
   particular, with 16 assignments, is unlikely to be a mistake.

4. **The old sheet's `الاولي من شوال` column means Eid**, and the office wants Eid khutbahs
   scheduled here too. Now modelled via `date_type: special` with a required label. If the
   office in fact handles Eid entirely outside this system, the toggle is harmless — but
   confirm, because the reverse mistake is discovered on Eid morning.

5. **`M001`–`M085` and `K001`–`K127`** follow the old sheet's row order, which carries no
   meaning. Fine as opaque keys, but they are not a ranking.

6. **One spreadsheet per year is not assumed.** All assignments live in one tab indefinitely.
   At 85 rows per Friday that is ~4,400 rows a year — fine for years. Revisit past ~50,000.
