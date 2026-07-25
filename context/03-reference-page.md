# The reference page

`context/reference-public-page.html` is a real, working page the client built and published
at `https://omarmagdy99.github.io/Aokaf-Tepeen/mayo15.html`. **The client wants the public
schedule page to look and behave exactly like this.** Read the file — do not guess from this
summary.

It is also proof that the chosen architecture already works in the client's hands.

## What it does

Fetches JSON from an Apps Script endpoint and renders a filterable table of
`mosque | mujawra | khatib`.

```js
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxGfd9nD_Iiy4Mhv-Sxy9kSzBCQFpr40FVtnmap5aESTqJsZZcDjo5wLNNfOZ5TX9Y2Gg/exec';
```

The response shape is `{ mayo: [ [header...], [mosque, area, preacher], ... ] }` — raw sheet
rows. Row 0 is skipped as a header. This endpoint belongs to the old single-Friday sheet and
will be replaced, but the **fetch-render-filter pattern is the thing to keep.**

## UI elements to carry over

| Element | Behaviour |
| --- | --- |
| Pill tab bar | Two tabs switch which field the search box filters: mosque name, or khatib name |
| Single search input | Filters live on every keystroke. `✕` button clears it. |
| Counter bar | Total records, and how many are currently visible |
| `استخراج PDF` | Exports the visible table via `html2canvas` + `jsPDF` (both from cdnjs) |
| `عرض الكل` | Clears the filter |
| Empty state | Friendly message when a search matches nothing |
| Error state | Message plus a reload button when the fetch fails |

## Visual language

RTL, Arabic. White cards on `#f0f4f8`, `border-radius: 24px` on the container, pill-shaped
controls (`border-radius: 50px`), navy `#1e3c5c` as the primary colour, blue `#3498db` for
focus. Emoji used as icons throughout (`🕌 📍 🎙️ 🔍 📊 📄 🔄`). The client likes this — keep it.

## The one function worth stealing verbatim

```js
function normalizeText(text) {
    if (!text || text === 'غير محدد') return '';
    return text.toString()
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/[ى]/g, 'ي')
        .replace(/[ة]/g, 'ه')
        .replace(/[ث]/g, 'س')
        .replace(/[ذ]/g, 'ز')
        .replace(/[ؤ]/g, 'و')
        .replace(/[ئ]/g, 'ي')
        .replace(/\s+/g, ' ')
        .trim();
}
```

Arabic orthography varies (hamza forms, ta marbuta vs ha, alif maqsura vs ya), so users
routinely type a name differently from how it is stored. Reuse this for **all** search and
for duplicate detection when adding a khatib.

Note it also folds `ث→س` and `ذ→ز`, which is dialect-driven and aggressive for search but is
the client's own choice. Keep it for search; **do not** use it as a uniqueness key.

## Known data errors in the reference page

The page's data drifted from the master sheet because it was maintained separately:

| On the page | In the sheet |
| --- | --- |
| `حمد أحمد فريد` | `محمد أحمد فريد` |
| `سامي احمد عالم` | `سامي احمد علام` |

This is exactly the class of bug the rewrite eliminates — the public page must be generated
from the same records the admin edits, never maintained by hand.
