# API — Apps Script Web App contract

One Apps Script project bound to the spreadsheet, deployed as a Web App with access set to
**Anyone**. The frontend on GitHub Pages is the only client.

## CORS — read this before writing any fetch call

This is the constraint that shapes the whole API, so it comes first.

An Apps Script Web App **cannot set arbitrary response headers and does not respond to
`OPTIONS`**. Any request that triggers a CORS preflight therefore fails outright — and
`Content-Type: application/json` triggers a preflight. The naive
`fetch(url, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(x)})`
will never work from `omarmagdy99.github.io`.

**The approach:** send every write as a POST whose `Content-Type` is
`text/plain;charset=utf-8`, with the JSON as the raw body string and **no custom headers**.
That is a CORS *simple request*, so the browser skips the preflight entirely. Apps Script
reads the body from `e.postData.contents` and parses it.

```js
async function call(action, payload) {
  const res = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action, token: getToken(), ...payload }),
  });
  return res.json();
}
```

**Its limitation, stated plainly:** the auth token travels in the request *body*, not in an
`Authorization` header, because adding that header would reintroduce the preflight. This is a
workaround, not good practice. It is acceptable here — the transport is still HTTPS, so the
body is encrypted in transit — but it means the token cannot be an `HttpOnly` cookie and must
sit in `localStorage`, reachable by any script on the page. Keep the frontend free of
third-party scripts. The two CDN libraries used for PDF export (`html2canvas`, `jsPDF`) are
the only exception and should be pinned to an exact version.

`/exec` also answers with a 302 to `script.googleusercontent.com`. `fetch` follows it
automatically; do not set `redirect: 'manual'`.

## Naming across the two layers

Sheet columns are `snake_case` (`date_type`, `mosque_id`, `updated_at`). JSON fields are
`camelCase` (`dateType`, `mosqueId`, `updatedAt`). The mapping happens in one place in the
script — a single row-to-object function per tab — and nowhere else. Two conventions is a
deliberate choice, not drift: the sheet is read by humans who see the headers, and the JSON is
read by JavaScript.

## Envelope

Every response, success or failure:

```json
{ "ok": true,  "data": { } }
{ "ok": false, "error": { "code": "KHATIB_DOUBLE_BOOKED", "message": "...", "details": { } } }
```

HTTP status is always 200 — Apps Script gives no clean way to set status codes on
`ContentService` output. Clients must branch on `ok`, never on `res.status`.

### Error codes

| Code | Meaning |
| --- | --- |
| `UNAUTHENTICATED` | Missing, unknown, or expired token |
| `BAD_REQUEST` | Malformed payload or a failed field validation |
| `NOT_FOUND` | Referenced id does not exist |
| `KHATIB_DOUBLE_BOOKED` | Khatib already assigned elsewhere that date |
| `PERMANENT_CONFLICT` | Khatib is already the permanent khatib of another mosque |
| `STALE_WRITE` | Someone else saved this date after you loaded it |
| `DUPLICATE` | Record already exists |
| `LOCKED` | Could not acquire the write lock in time |
| `INTERNAL` | Unhandled failure; details logged, not returned |

## Auth

`login` — no token required.

```json
{ "action": "login", "username": "fatma", "password": "..." }
→ { "ok": true, "data": { "token": "7d3f…", "displayName": "فاطمة عبد الله", "expiresAt": "2026-08-01T18:00:00Z" } }
```

Failure returns `UNAUTHENTICATED` with a deliberately vague message — never reveal whether it
was the username or the password that was wrong.

`logout` — `{ token }` → `{ ok: true, data: {} }`. Deletes the session row. Succeeds even for
an unknown token; there is nothing to protect by failing.

`whoami` — `{ token }` → `{ ok: true, data: { username, displayName } }`, or
`UNAUTHENTICATED`. Called on every page load so a stale tab redirects to login instead of
failing on the user's first real action.

Every other action requires a valid `token`. The check happens **before** any sheet read.

## Every handler wraps in try/catch — this is not optional

When Apps Script throws an unhandled error, Google's proxy returns an **HTML error page with
no CORS headers**. The browser cannot read it, so `fetch` rejects with
`TypeError: Failed to fetch` — indistinguishable from a CORS misconfiguration. A null
dereference in `saveSchedule` therefore presents as "CORS is broken", and hours get spent
debugging the wrong layer.

Every entry point catches everything and returns a structured envelope:

```js
function doPost(e) {
  try {
    return json(handle(JSON.parse(e.postData.contents)));
  } catch (err) {
    console.error(err.stack);
    return json({ ok: false, error: { code: 'INTERNAL', message: String(err) } });
  }
}
```

## Reads

| Action | Payload | Returns |
| --- | --- | --- |
| `listMosques` | `{ includeInactive? }` | all mosque rows |
| `listKhatibs` | `{ includeInactive? }` | all khatib rows, each with its `preferences` array |
| `getSchedule` | `{ date }` | the date's 85 assignment rows, each joined to mosque name/mujawra and khatib name |
| `getKhatibSchedule` | `{ khatibId, from, to }` | one khatib's assignments in a range |
| `listDates` | `{ from?, to? }` | every date that has assignment rows, with filled/empty counts |
| `getLoadCounts` | `{ from?, to? }` | `{ counts: { khatibId: n } }` — sermons per khatib in the range |

`getLoadCounts` exists so the scheduling screen can show each khatib's current load beside
their name in one request. The obvious alternative — fetching each Friday and counting on the
client — costs eight round trips of one to three seconds each on every page load.

Read actions return **camelCase** (`permanentKhatibId`), matching what write actions accept.
Internally the script keeps working on raw `snake_case` sheet rows; the conversion happens in
`publicMosque_` / `publicKhatib_` at the API boundary only.

`getSchedule` returns a `version` field — the maximum `updated_at` across the returned rows.
The client sends it back on save. That is the whole concurrency story for the schedule screen.

## Writes — mosques and khatibs

| Action | Payload | Returns |
| --- | --- | --- |
| `createMosque` | `{ name, mujawra, address?, permanentKhatibId? }` | `{ id }` |
| `updateMosque` | `{ id, name, mujawra, address?, permanentKhatibId?, active? }` | `{ id }` |
| `deactivateMosque` | `{ id }` | `{ clearedAssignments, clearedPermanentAt }` |
| `createKhatib` | `{ name, phone?, type, notes? }` | `{ id, similarTo }` |
| `updateKhatib` | `{ id, name, phone?, type, notes?, active? }` | `{ id }` |
| `deactivateKhatib` | `{ id }` | `{ clearedAssignments, clearedPermanentAt }` |
| `getSettings` | `{}` | `{ settings }` — the publish window and ID counters |

`createKhatib` returns `similarTo`: the ids of existing khatibs whose normalized name matches.
The record is created regardless — two people genuinely can share a name — but the UI shows
the match so a typo is caught at the moment it happens.

`phone` is optional and stays optional; when present it must be 11 digits starting `01`.

Deactivation, not deletion. A deleted mosque would orphan every historical assignment that
referenced it. `active: FALSE` hides it from the scheduling screen and the public page while
keeping history readable.

**Deactivation must clean up the references it leaves behind.** Setting a flag is not enough:

`deactivateKhatib` also, inside the lock —

1. Clears `permanent_khatib_id` on any mosque pointing at them. Otherwise `generateDate`
   keeps happily assigning a khatib who no longer serves.
2. Finds every **future** assignment holding that `khatib_id`, sets it to `unassigned` with an
   empty `khatib_id`, and returns the affected dates and mosques so the UI can say
   `تم إخلاء 6 خطبة قادمة — تحتاج إعادة توزيع`. Past assignments are history and stay untouched.

`deactivateMosque` similarly drops that mosque's future `unassigned` rows and reports how many
assigned ones it left alone.

Both return a summary rather than acting silently — a deactivation that quietly empties six
future Fridays is worse than one that refuses.

`createMosque` / `updateMosque` validate that `permanent_khatib_id`, if present, is not
already the permanent khatib of a different mosque → `PERMANENT_CONFLICT`.

`setPreferences` replaces a khatib's whole preference list in one call:

```json
{ "action": "setPreferences", "khatibId": "K001", "mosqueIds": ["M042", "M017"] }
```

Replace-all rather than add/remove — the UI is a multi-select, so the client always knows the
complete desired state, and a replace cannot drift out of sync the way incremental edits can.

## Writes — scheduling

### `generateDate`

```json
{ "action": "generateDate", "date": "2026-07-31" }
```

Creates one `assignments` row for every active mosque. A mosque with a `permanent_khatib_id`
is pre-filled with it and marked `confirmed`; every other mosque gets an empty `khatib_id`
and `unassigned`.

**This action takes the same script lock as `saveSchedule`, and the existence check happens
inside it.** Without the lock, two admins clicking `توليد الجمعة` at the same moment both read
zero rows for the date and both append 85 — leaving 170 rows with duplicate ids, which breaks
every lookup that follows. Idempotency is not achieved by the existence check alone; it is
achieved by the check being inside the lock.

If rows for that date already exist, it returns them untouched rather than duplicating or
overwriting. Regenerating must never silently wipe an admin's work.

`dateType` selects what is being generated:

| Value | Accepts | Purpose |
| --- | --- | --- |
| `friday` (default) | Fridays only, else `BAD_REQUEST` | The weekly khutbah |
| `special` | any date; requires a `label` | Eid and other occasions |

The old sheet has a column headed `الاولي من شوال` — the office already schedules Eid
khutbahs, which fall on weekdays. A Friday-only system would push that work back onto paper.
`label` is stored on the assignment rows and shown wherever the date appears.

Returns the same shape as `getSchedule`.

### `saveSchedule`

```json
{
  "action": "saveSchedule",
  "date": "2026-07-31",
  "version": "2026-07-25T18:42:07Z",
  "changes": [
    { "mosqueId": "M001", "khatibId": "K071", "status": "confirmed" },
    { "mosqueId": "M002", "khatibId": "",      "status": "unassigned" }
  ]
}
```

Sends only changed rows, not all 85.

Order of operations inside the lock:

1. Acquire `LockService.getScriptLock()` with a 20-second timeout. On timeout → `LOCKED`.
2. Re-read the date's rows. If any `updated_at` is newer than the submitted `version` **and**
   touches a mosque in `changes` → `STALE_WRITE`, with the conflicting rows in `details`.
3. Validate the batch against itself: the same `khatibId` twice in one payload →
   `KHATIB_DOUBLE_BOOKED`.
4. Validate against the sheet: each `khatibId` must not already hold a different mosque on
   that date → `KHATIB_DOUBLE_BOOKED` with the mosque it clashes with.
5. Write all rows, stamping `updated_by` and `updated_at`.
6. Release the lock. Return the fresh schedule and its new `version`.

**Nothing is written unless every check passes.** A partial save that leaves half the Friday
applied is worse than a rejected one.

Step 2 is scoped to *touched* mosques on purpose: two admins working on different halves of
the same Friday should both succeed. Blocking on any concurrent edit to the date would make
the multi-admin requirement unusable in practice.

**Why the aggregate `version` is sufficient, despite looking too weak.** It is a single
`max(updated_at)` for the whole date, not a per-row timestamp, which invites the objection
that an edit to an older row slips under the maximum. It cannot. Any competing write
necessarily happens *after* the client's read, and the maximum was computed *from* the data
present at that read — so a later write always carries a timestamp greater than the version it
must beat. The comparison is against read time, not against that row's own history.

Two caveats that are real:

- Timestamps come from the server inside the lock, never from the client. A client clock would
  break the argument immediately.
- Rows created after the read — by a concurrent `generateDate` — are not covered by the
  version. This is harmless: the client cannot submit changes for mosques it never saw.

### `publishRange`

```json
{ "action": "publishRange", "from": "2026-07-31", "to": "2026-08-28" }
```

Writes `publish_from` / `publish_to` into `settings`. An empty `from` unpublishes everything.

## The public read

`doGet` — **the only unauthenticated endpoint.**

```
GET {APPS_SCRIPT_URL}?date=2026-07-31
```

Returns only dates inside the published window; anything outside it returns an empty list,
never an error, so the public page cannot be used to probe unpublished drafts.

```json
{
  "ok": true,
  "data": {
    "date": "2026-07-31",
    "rows": [ { "mosque": "النور المحمدي", "mujawra": "مجاورة 1", "khatib": "محمد أحمد فريد" } ]
  }
}
```

With no `date` parameter it returns the full published range plus the list of available dates,
so the public page can render a date picker.

Names, not ids — this response is for humans and must stay trivially renderable. Rows whose
`khatib_id` is empty are returned with `khatib: ""`; the page shows `لم يُحدد بعد`. Hiding
them would make a mosque look absent from the directory.

## Rate and quota reality

The audience is roughly 160 people. At a few seconds of script runtime per request, the
consumer-account budget of ~90 minutes per day is not a constraint, and no caching layer is
planned. If the page is ever shared beyond the khatibs, the mitigation is a `CacheService`
wrapper on `doGet` keyed by date — a contained change to one function, not a redesign.

### `regenerateDate`

```json
{ "action": "regenerateDate", "date": "2026-07-31", "mode": "fill" }
```

Runs against a date that already has rows; returns `NOT_FOUND` otherwise, pointing the caller
at `generateDate`. Takes the same lock.

| `mode` | Effect |
| --- | --- |
| `fill` (default) | Adds rows for mosques created since the date was generated, and fills empty slots from each mosque's permanent khatib. **Touches no existing assignment.** |
| `reset` | Clears every assignment on the date, then re-applies permanent khatibs only. |

`fill` exists because of a real gap: `generateDate` returns early when rows exist, so a mosque
added afterwards was silently absent from that date with no way to add it.

A permanent khatib already booked elsewhere on that date is **skipped, not double-booked** —
the mosque stays empty and its name comes back in `skipped` so the UI can say so rather than
leaving the gap unexplained.

Returns the schedule plus `{ mode, addedMosques, filled, cleared, skipped }`.
