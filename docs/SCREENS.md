# Screens

Seven screens. Six behind a login, one public.

All of them are Arabic and RTL (`<html dir="rtl" lang="ar">`), mobile-first, and reuse the
visual language of `context/reference-public-page.html`: white cards on `#f0f4f8`, `24px`
container radius, pill controls at `50px`, navy `#1e3c5c` primary, blue `#3498db` focus,
emoji as icons.

## Shared behaviour

**`normalizeText()`** from the reference page is used for **every** search box and for
duplicate detection when adding a name. It folds hamza forms, `ة`/`ه`, `ى`/`ي`, and collapses
whitespace, so a user who types `احمد` finds `أحمد`. It is a *search* helper only — never
store the normalized form, and never use it as a uniqueness key, because it also folds `ث→س`
and `ذ→ز`, which would collide genuinely different names.

**Three states, every screen, every time.** Loading: a centred message, never a blank page.
Empty: a friendly line explaining what to do, not "no data". Error: the message plus a retry
button that re-runs the failed call, not `location.reload()`.

**Toasts, not `alert()`.** Every write reports success or failure in a dismissible bar.

**Mobile.** Below ~700px, every table collapses from columns into stacked cards — the label
sits above the value. The reference page's three-column grid already does this; extend the
same rule rather than inventing a second pattern.

---

## 1. Login

The only unauthenticated admin screen.

| Field | Type | Validation |
| --- | --- | --- |
| `اسم المستخدم` | text | required |
| `كلمة المرور` | password | required |

One button: `دخول`. On success, store the token in `localStorage` and go to the schedule
screen. On failure show one message — `اسم المستخدم أو كلمة المرور غير صحيحة` — never
distinguish which was wrong.

On every page load, call `whoami` before rendering anything. An expired token sends the user
here instead of letting them fill in a form that will fail on save.

---

## 2. Mosques

| Field | Type | Validation |
| --- | --- | --- |
| `اسم المسجد` | text | required; warn on a normalized-duplicate name |
| `المجاورة` | text with datalist of existing values | required |
| `العنوان` | textarea | optional |
| `الخطيب الثابت` | searchable select of active khatibs | optional |
| `نشط` | toggle | defaults on |

The mujawra field is a free-text input backed by a `<datalist>` of values already in use, not
a locked dropdown. The real data mixes `مجاورة 1` with `الإسكان العائلي`, `120 فدان`, and
`المنطقة الصناعية` — a hard enum would block a legitimate new zone.

**`الخطيب الثابت` is the field that removes most of the weekly work.** Choosing a khatib who
is already permanent elsewhere is rejected inline, naming the other mosque, before the save
is attempted.

The list shows: name, mujawra, permanent khatib, and an active/inactive badge. Search filters
on name and mujawra together. Sort by mujawra then name — that is how staff think about the
city.

Deactivating asks for confirmation and states plainly that history is kept and the mosque
disappears from future Fridays. There is no delete.

---

## 3. Khatibs

The screen the client asked to mirror the reference page.

**Carried over verbatim:** the pill tab bar, the single live-filtering search input with its
`✕` clear button, the `إجمالي / ظاهر` counter bar, `📄 استخراج PDF`, and `🔄 عرض الكل`.

**Changed on purpose:** on the reference page the tabs switch *which field* is searched. Here
there is only one name field to search, so the tabs become a filter on type instead:

`الكل` · `أساسي` · `متطوع` · `غير نشط`

| Column | Notes |
| --- | --- |
| `الاسم` | |
| `رقم الهاتف` | monospace; when empty, a red `ناقص` marker with a warning icon |
| `النوع` | badge — blue `أساسي`, green `متطوع` |
| `المساجد المفضلة` | comma-separated names, truncated with a `+3` chip |
| actions | edit, deactivate |

The missing-phone marker exists for one concrete reason: **all 127 phone numbers are being
typed in by hand.** A counter above the table — `ناقص رقم الهاتف: 43` — is the progress bar
for that job, and clicking it filters to exactly those rows.

Add/edit form:

| Field | Type | Validation |
| --- | --- | --- |
| `الاسم` | text | required; on a normalized-duplicate, warn and show the existing record — do not block, two people genuinely can share a name |
| `رقم الهاتف` | tel | optional; accept `01xxxxxxxxx`, strip spaces and dashes, reject anything that is not 11 digits starting `01` |
| `النوع` | radio | required |
| `ملاحظات` | textarea | optional |
| `المساجد المفضلة` | multi-select with its own search | optional |
| `نشط` | toggle | defaults on |

PDF export renders the currently visible rows, not all 127 — the filter is the point.

---

## 4. Scheduling

The core screen. Everything else exists to feed it.

### Choosing the date

A date input that **defaults to Fridays only**. `<input type="date">` cannot restrict by
weekday, so: keep the native picker for reachability, and reject a non-Friday on change with
`اختر يوم جمعة`. Alongside it, a row of quick buttons for the next four Fridays, computed in
the browser — that is what will actually get clicked.

A `مناسبة خاصة` toggle lifts the Friday restriction and reveals a required label field
(`الأولى من شوال`, `خطبة عيد الأضحى`). Eid falls on a weekday, and the old sheet already has a
column for it — without this, that work goes back to paper the first Eid after launch.

If the date has no rows yet, the screen shows a single call to action:
`لم يتم إنشاء هذه الجمعة بعد` with a `توليد الجمعة` button.

### Generating

`توليد الجمعة` creates all 85 rows, pre-filling every mosque that has a permanent khatib. The
result banner is specific: `تم إنشاء 85 مسجد — 31 اتملى تلقائيًا، 54 محتاجين توزيع`.

Re-running it on an existing date changes nothing. Say so on the button's tooltip so nobody
fears clicking it twice.

### Assigning

One row per mosque: mosque name, mujawra, and a searchable khatib select.

**The dropdown must reproduce the old sheet's most valuable behaviour — availability.** For
the selected date, every khatib already assigned to a *different* mosque is shown greyed out
and disabled, labelled with where they are: `محمد خليل — محجوز: الرئيسي مجاورة 3`. Disabled
and visible, not hidden: an admin looking for a specific person needs to learn *why* they
cannot have them, otherwise they will assume the list is broken.

Ordering inside the dropdown:

1. The mosque's permanent khatib, if any
2. Khatibs who listed this mosque in `preferences`
3. Everyone else available, by name
4. Everyone unavailable, greyed, at the bottom

Beside each name, the count of Fridays that khatib already holds in the current window —
`(3)`. The client did not ask for this. It is one number that makes an unfair distribution
visible at the moment the decision is made, and it costs nothing to compute from data already
loaded.

### Seeing what is left

Fixed above the table: `متبقي بدون خطيب: 54`. Clicking it filters to exactly those mosques.
This is the screen's real job — the old sheet had no way at all to answer "which mosque has
nobody this Friday", which is how a mosque ends up with a number instead of a name.

A search box filters by mosque name or mujawra.

### Recording an excuse

Each row carries a small status control alongside the khatib select: `مؤكد` · `معتذر`.

When a khatib withdraws, staff set `معتذر` — the khatib stays recorded on the row and the
mosque joins the "still needs someone" count. Clearing the name instead would erase who was
originally assigned, which is precisely the fact the office needs when chasing a replacement.

`شاغر` is not selectable; it is what a row shows when no khatib is set.

### Saving

One `حفظ` button for the whole date, sending only changed rows. Also `📄 استخراج PDF`, which
exports the date's table as the printable master schedule — the office keeps a paper copy, and
a browser print dialog renders the dropdowns badly.

- Unsaved changes mark their row and enable the button; leaving the page warns.
- `KHATIB_DOUBLE_BOOKED` highlights both rows and names the clash.
- `STALE_WRITE` shows who saved and when, lists the conflicting mosques, and offers
  `تحديث` — reload their version — or `اكتب فوقه`. It never silently discards either side.

---

## 5. Khatib schedule

**The old sheet's second half, which the other screens do not replace.**

In the current sheet, the `الخطباء` tab answers a question the mosque-by-mosque grid cannot:
*where am I assigned over the next few weeks?* Khatibs ask the office this constantly. Without
this screen, answering one phone call means opening four to eight separate Friday screens.

Pick a khatib and a date range — defaulting to the next eight Fridays — and get their
schedule: date, mosque, mujawra, status.

- A summary line: `4 خطب في الفترة المختارة`
- Free Fridays shown explicitly as `— لا يوجد` rather than omitted, so gaps are visible
- `📄 استخراج PDF` — this is the sheet a khatib gets sent on WhatsApp
- Reachable in one click from any khatib's row on screen 3

Backed by `getKhatibSchedule`, which the API already defines.

## 6. Publishing

Small screen, or a panel on the schedule screen.

Two date inputs, `من` and `إلى`, plus a `نشر` button and a preview of what the public will
see. A visible line states the current window: `المنشور حاليًا: 31 يوليو — 28 أغسطس`.

An `إلغاء النشر` button clears it. Confirm first: it removes the schedule from everyone at
once.

---

## 7. Public schedule

No login. This is the screen the client wants to look like the reference page, because it
already does.

A date selector limited to published dates, defaulting to the nearest upcoming Friday. Then
the reference page's table, unchanged in structure: `🕌 المسجد` · `📍 المجاورة` · `🎙️ الخطيب`.

Everything else carries over as-is: the two search tabs (**here they are genuinely useful** —
mosque name and khatib name are two different searches), the live filter with its clear
button, the counter, `استخراج PDF`, and `عرض الكل`.

Mosques with nobody assigned show `لم يُحدد بعد` in muted text rather than being filtered out.

Empty state, when nothing is published: `لم يتم نشر الجدول بعد` — not an error, because it
is not one.

**This page is generated from the same rows the admin edits.** The current page is maintained
by hand and has already drifted — it shows `حمد أحمد فريد` where the sheet says
`محمد أحمد فريد`, and `سامي احمد عالم` where the sheet says `سامي احمد علام`. That class of
bug disappears here by construction, and it is worth stating in the handover so nobody
reintroduces a hand-edited copy.
