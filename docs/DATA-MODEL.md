# Data model — Google Sheets schema

One spreadsheet, seven tabs. Every tab has its header text in **row 1**; data starts at row 2.

## Conventions

**Dates are text, never Sheets dates.** Every date column is formatted as *Plain text* and
holds an ISO string: `2026-07-31`. Google Sheets silently reinterprets date cells by the
spreadsheet's locale and timezone, and Apps Script's `getValues()` hands back a JS `Date`
that has already been shifted. Storing text removes the entire class of bug. The API parses
and validates the string itself.

**IDs are opaque text, assigned once, never reused.** `M001`, `K001`. They are the only
thing that joins tables. A khatib's name may be corrected at any time without touching a
single assignment — this is the fix for defect 6 in the old sheet.

**Booleans are written as `TRUE` / `FALSE`, and always read through a coercion helper.**
Sheets stores a cell containing `TRUE` as a real boolean, so `getValues()` hands back `true`,
not `'TRUE'`. A strict `row[i] === 'TRUE'` comparison therefore silently treats every active
record as inactive. Never compare directly:

```js
const isTrue = v => String(v).toUpperCase() === 'TRUE';
```

Use it at every read site, without exception.

**Every write goes through `setValues()` followed by `setNumberFormat('@')` on the written
range — never bare `appendRow()`.** Appended cells can pick up Sheets' own type detection
regardless of how the column was formatted at setup, which turns `01001234567` into
`1001234567` and `2026-07-31` into a locale-shifted Date. Formatting the column in Phase 0 is
necessary but not sufficient; the script must re-assert the format on what it writes.

**Timestamps are ISO 8601 UTC**: `2026-07-25T18:42:07Z`.

---

## `mosques`

| Column | Header | Type | Required | Example |
| --- | --- | --- | --- | --- |
| A | `id` | text | yes | `M001` |
| B | `name` | text | yes | `النور المحمدي` |
| C | `mujawra` | text | yes | `مجاورة 1` |
| D | `address` | text | no | `شارع 9، بجوار المدرسة الإعدادية` |
| E | `permanent_khatib_id` | text | no | `K071` |
| F | `active` | `TRUE`/`FALSE` | yes | `TRUE` |
| G | `created_at` | timestamp | yes | `2026-07-25T18:00:00Z` |

`mujawra` is the neighbourhood. It is not always literally a *mujawra* — the real data also
contains `الإسكان العائلي`, `120 فدان`, `المنطقة الصناعية`, `دار مصر`. Treat it as a free-text
zone label, not an enum.

**A mosque's identity is `(name, mujawra)`, not `name`.** The client confirmed this: the same
mosque name recurs across the city — `الرحمن` exists in مجاورة 6, 9, 13 and 23; `التوحيد` in
مجاورة 2, 8 and المنطقة الصناعية — but a name never repeats inside one zone. The API rejects a
second mosque with the same normalized name *and* mujawra, and permits the name anywhere else.

`permanent_khatib_id` is the mosque's standing preacher. **The API enforces that a given
khatib id appears in this column at most once.**

Seed from `context/mosques.csv` — 85 rows, ids `M001`–`M085` already assigned.

## `khatibs`

| Column | Header | Type | Required | Example |
| --- | --- | --- | --- | --- |
| A | `id` | text | yes | `K001` |
| B | `name` | text | yes | `أحمد إبراهيم طنطاوي` |
| C | `phone` | text | no | `01001234567` |
| D | `type` | `primary` \| `volunteer` | yes | `primary` |
| E | `notes` | text | no | `متاح بعد صلاة العصر فقط` |
| F | `active` | `TRUE`/`FALSE` | yes | `TRUE` |
| G | `created_at` | timestamp | yes | `2026-07-25T18:00:00Z` |

`phone` is **text**, not a number — a leading zero is significant in Egyptian mobile numbers
and a numeric cell destroys it. `01001234567` becomes `1001234567`. Format the column as
plain text before importing anything.

`type` is stored in English and rendered as `أساسي` / `متطوع`. It carries **no scheduling
rule** — the client confirmed this explicitly. It exists to display and to filter.

Seed from `context/khatibs.csv` — 127 rows, ids `K001`–`K131`. **`phone` is empty for all
131** and will be typed in by hand. It is **optional** — the office is entering them
gradually, and a khatib with no number must still be schedulable.

## `preferences`

Which mosques a khatib is willing to serve. Many-to-many.

| Column | Header | Type | Required | Example |
| --- | --- | --- | --- | --- |
| A | `khatib_id` | text | yes | `K001` |
| B | `mosque_id` | text | yes | `M042` |

No surrogate id — the pair *is* the key. The API rejects duplicate pairs.

This is advisory only. It sorts the dropdown on the scheduling screen; it never blocks an
assignment. A khatib with no rows here is simply un-ranked, not unavailable.

## `assignments`

The table that replaces the old wide matrix. **One row per mosque per Friday.**

| Column | Header | Type | Required | Example |
| --- | --- | --- | --- | --- |
| A | `id` | text | yes | `2026-07-31_M001` |
| B | `date` | ISO date text | yes | `2026-07-31` |
| C | `mosque_id` | text | yes | `M001` |
| D | `khatib_id` | text | no | `K071` |
| E | `status` | enum | yes | `confirmed` |
| F | `date_type` | `friday` \| `special` | yes | `friday` |
| G | `label` | text | no | `الأولى من شوال` |
| H | `updated_by` | text | yes | `fatma` |
| I | `updated_at` | timestamp | yes | `2026-07-25T18:42:07Z` |

`date_type` and `label` exist because the office schedules Eid khutbahs, not only Fridays —
the old sheet has a column headed `الاولي من شوال`. A Friday-only model would send that work
back to paper.

`id` is the composite `{date}_{mosque_id}`. This is deliberate:

- A mosque can only have one preacher on one Friday, so the natural key is already unique.
- Saving becomes an upsert keyed on a value the client can compute without a round-trip.
- A duplicate row is structurally impossible to create by accident.

`khatib_id` **may be empty**. An empty cell is a real, meaningful state: "this Friday exists
for this mosque and nobody is assigned yet." That is exactly what the old sheet could not
express, and why 60+ mosque-Fridays silently had a number where a name should have been.

`status` values:

| Value | Arabic label | Meaning |
| --- | --- | --- |
| `confirmed` | `مؤكد` | Assigned and expected to attend |
| `unassigned` | `شاغر` | Row exists, no khatib yet |
| `excused` | `معتذر` | Assigned khatib withdrew; needs a replacement |

Rows are created in bulk when an admin generates a Friday, so an entire date's 85 rows exist
from the start — that is what makes "which mosques are still empty" a simple filter instead
of a diff against the mosque list.

## `users`

| Column | Header | Type | Required | Example |
| --- | --- | --- | --- | --- |
| A | `username` | text | yes | `fatma` |
| B | `display_name` | text | yes | `فاطمة عبد الله` |
| C | `password_hash` | text | yes | `9f2c...` (64 hex chars) |
| D | `salt` | text | yes | `a3f19c...` (32 hex chars) |
| E | `active` | `TRUE`/`FALSE` | yes | `TRUE` |
| F | `created_at` | timestamp | yes | `2026-07-25T18:00:00Z` |

`password_hash` is `SHA-256(salt + password)` via `Utilities.computeDigest`, hex-encoded.

**Be honest about what this is.** Salted SHA-256 is not bcrypt or Argon2 — it has no work
factor, so it does not resist an offline brute-force attack on a leaked sheet. Apps Script
ships no KDF. This is acceptable here because the data is a public prayer schedule and the
worst outcome of a compromised account is a vandalised roster, not a financial or personal
loss. It is documented so nobody later assumes a strength that is not there.

Anyone who can open the spreadsheet can read this tab. Restrict spreadsheet sharing to the
Awqaf staff who already have admin accounts.

## `sessions`

| Column | Header | Type | Required | Example |
| --- | --- | --- | --- | --- |
| A | `token` | text | yes | `7d3f...` (64 hex chars) |
| B | `username` | text | yes | `fatma` |
| C | `expires_at` | timestamp | yes | `2026-08-01T18:00:00Z` |

Tokens live 7 days. A scheduled trigger deletes expired rows nightly; the API also treats an
expired token as invalid regardless of whether the row still exists, so a missed cleanup is
never a security hole.

## `settings`

Key-value. One row per setting.

| Column | Header | Type | Example |
| --- | --- | --- | --- |
| A | `key` | text | `publish_from` |
| B | `value` | text | `2026-07-31` |

| Key | Meaning |
| --- | --- |
| `publish_from` | Earliest date visible on the public page (ISO date) |
| `publish_to` | Latest date visible on the public page (ISO date) |
| `next_mosque_seq` | Counter behind new mosque ids |
| `next_khatib_seq` | Counter behind new khatib ids |

---

## Which columns a human may safely edit by hand

The whole point of keeping Sheets is that staff can open it. But not every column is safe.

**Safe to edit directly:** `mosques.name`, `mosques.mujawra`, `mosques.address`,
`khatibs.name`, `khatibs.phone`, `khatibs.notes`, `settings.value` for the publish window.

**Never edit by hand:** any `id` column, `assignments.khatib_id`, `preferences`, the whole
`users` and `sessions` tabs, and the `next_*_seq` counters.

Editing `assignments.khatib_id` in the sheet bypasses the double-booking check — the one rule
the whole system exists to enforce. Editing an id orphans every row that referenced it.

Protect those ranges via *Data → Protect sheets and ranges* so the warning is enforced rather
than merely written down here.
