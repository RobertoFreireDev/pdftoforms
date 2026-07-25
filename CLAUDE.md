# pdftoformext

Browser extension (Chrome, Manifest V3) that loads a PDF, extracts every field and
table from it into a single keyed object held in memory, and uses that object to
fill the form on the page the user is currently viewing — through the per-URL
mappings the user configured, and only those.

## Status

Implemented and working end to end: overlay, extraction (AcroForm + geometric
tables), mapping-driven fill, and per-URL field mapping. pdf.js 4.6.82 is
vendored. Update this file as pieces change.

## Core flow

1. A content script injects a **draggable arrow button**, starting in the top-right
   corner of the current page. It expands (▾/▴) into the panel and does nothing else
   — dragging it anywhere is the only other thing it does.
2. **Load PDF…** in the panel opens a file picker
   (`<input type="file" accept="application/pdf">`). Loading only extracts; it fills
   nothing.
3. The chosen PDF is parsed **client-side** with pdf.js. Extraction produces one
   flat object: every AcroForm field and every table cell in the document gets a key.
4. That object lives **in memory only** (a module-level variable in the content
   script). It is never written to `chrome.storage`, `localStorage`, cookies, a
   server, or anywhere else, and it is discarded on page unload.
5. **Fill page** is the one and only place that writes to the page's inputs, and
   it writes **only what the mapping rows currently on screen name**. There is no
   guessing pass and no fallback. With no mappings, the button is disabled.

Which is also the enablement rule for the whole panel — each control is live only
when it can do something:

| Control | Enabled when |
|---|---|
| Load PDF… / Import | always |
| Config | a PDF is loaded (a mapping picks a PDF key; with no PDF there is none to pick) |
| Fill page | a PDF is loaded and ≥1 row on screen has both selector and key (Config open or closed) |
| Save | a row has both selector and key, **or** there are saved mappings to clear |
| Export | some stored site has ≥1 mapping |

`refreshControls()` in `overlay.js` owns all of it and is called from every place
that can change those conditions; `refreshExportState()` is separate only because
it has to read storage.

## Layout

```
manifest.json               MV3 manifest
src/
  content/
    bootstrap.js            classic content script; dynamic-imports overlay.js
    overlay.js              injects the button, owns the in-memory extraction object
    overlay.css             overlay styles (draggable, high z-index)
  lib/
    pdf-extract.js          PDF -> keyed object (fields + tables)
    autofill.js             keyed object -> page inputs, by mapping only
    mappings.js             per-URL selector->key config; storage + selector building
vendor/
  pdf.mjs                   pdf.js, vendored locally (MV3 CSP forbids remote scripts)
  pdf.worker.mjs
  LICENSE                   Apache 2.0, pdf.js
example/
  test-form.html            standalone page with fields, for manual testing
  test-form.pdf             fixture to fill from (AcroForm + two table shapes)
  make-test-pdf.mjs         regenerates test-form.pdf; authoring tool, not shipped
```

`bootstrap.js` exists because MV3 `content_scripts` cannot declare
`"type": "module"`. It is the only classic script; everything it pulls in is a
plain ES module, so every file under `src/` and `vendor/` that gets imported must
also be listed in `web_accessible_resources`.

No build step. Plain ES modules loaded directly by the extension — do not
introduce bundlers, TypeScript, or npm dependencies without being asked.

## The extraction object

One flat `Record<string, Value>`. Flat, not nested — autofill matching is simpler
against a flat keyspace, and the whole PDF must be represented.

Key conventions:

| Source | Key shape | Example |
|---|---|---|
| AcroForm field | `field.<sanitized field name>` | `field.applicant_name` |
| Table cell | `table.<tableIndex>.r<row>.c<col>` | `table.0.r3.c1` |
| Table cell w/ header | `table.<tableIndex>.<header>.<row>` | `table.0.total.3` |

Each value keeps its provenance so autofill can rank candidates:

```js
{
  key: 'field.applicant_name',
  value: 'Jane Doe',
  source: 'acroform' | 'table',
  page: 1,
  label: 'Applicant Name',   // nearest visible text, used for fuzzy matching
  rect: [x0, y0, x1, y1],
}
```

Rules:

- **Coverage is the requirement.** Every field and every table cell in the PDF must
  appear. Do not silently drop empty fields — emit them with an empty value.
- Keys must be **stable** for the same PDF and **unique**. On collision, suffix
  `__2`, `__3`, ….
- Text-only (non-AcroForm) PDFs: fall back to geometric extraction from
  `getTextContent()` — cluster text items into rows by shared `y`, into columns by
  shared `x`, and emit them under the `table.*` scheme.

How the geometric side behaves, since these choices are not obvious from the
key shapes alone:

- Clustering tolerances in `pdf-extract.js` are ratios of the page's median glyph
  height, not absolute points, so they survive different page sizes and font
  scales.
- A block needs ≥2 rows, ≥2 columns and good column alignment to count as a
  table — *unless* the document has no AcroForm fields at all, in which case the
  bar drops to one column so nothing in a text-only PDF is lost.
- A header row is only recognised at ≥3 columns. Two-column blocks are far more
  often a "Label   value" list, where reading row 0 as headers would label every
  value with the first row's value. Those blocks instead get each cell's `label`
  from the cell to its left, which is what makes label/value PDFs autofill well.
- Radio widgets sharing a field name collapse into one entry holding the selected
  option, rather than one entry per button.

## Filling

`autofill.js` exports exactly one entry point, `fillMapped(extraction, mappings)`.
It does not search the page and it does not score inputs against entries: for each
saved `selector -> key` row it resolves the selector, looks the key up, coerces the
value to the input's kind and writes it. **Do not reintroduce a guessing pass.**
An input nobody mapped is an input nobody wanted filled — that is the point of the
feature, not an accident of the implementation. Never submit the form.

Per row, everything that can go wrong is named rather than swallowed, in the
`skipped` array `fillMapped` returns: `invalid selector`, `selector matched
nothing`, `input is not writable`, `key not in PDF`, `value did not fit`. The
overlay does not render them — it reports only the filled/total count in the
status line, since the mappings themselves are already on screen in Config.

A mapping is an instruction, not a guess: no confidence threshold, no ambiguity
check, and existing values are overwritten.

Two details worth knowing before touching this file:

- Values are written through the prototype's `value`/`checked` setter, not
  `el.value = …`. React patches the instance property to track changes; assigning
  directly leaves the framework's state stale even though the DOM looks right.
  After setting, `input` and `change` are dispatched with `bubbles: true`.
- Similarity scoring (`similarity`, `FILL_THRESHOLD`) survives for one narrow job
  only: choosing which `<option>` or radio button of a *mapped* field the PDF's
  value refers to. It never decides which field gets filled.

## Field mapping (the Config section)

The mappings *are* the feature: a list of `CSS selector -> PDF key` rows, saved per
URL, and the only thing `Fill page` acts on.

- **Config needs a loaded PDF** and its button is disabled without one. A row is
  worthless until its key is chosen from the PDF's values, and `currentRowMappings()`
  silently drops keyless rows at save time — so the section is gated rather than
  left to invite work that would be thrown away.
- While Config is open, clicking any `input`/`select`/`textarea` on the page adds a
  row. That is the *only* way to add one — there is no Add button, because a blank
  row asks the user to hand-write a selector the picker would have got right.
  The click is `preventDefault`ed in the capture phase so picking a checkbox
  cannot toggle it. `selectorsFor()` offers candidate selectors (id, `[name]`,
  form-scoped `[name]`, `:nth-of-type` path), each verified to resolve to exactly
  that one element; the row's text input is `datalist`-backed so the user can type
  their own instead.
- The key dropdown is grouped — `Fields` for AcroForm entries, `Table N` per table
  — and each option shows `key — value` so the user picks by what they can see. A
  saved key that is not in the currently loaded PDF (or when none is loaded) is kept
  as its own option so re-rendering never loses a mapping.
- **Mappings are the only input to `Fill page`**, which calls `fillMapped` and
  touches nothing else on the page. It takes `currentRowMappings()` — the rows as
  they stand — not `savedMappings`, so a row can be tried before it is committed
  and the button stays live while Config is open. With no complete row, it is
  disabled. Rows outlive closing Config, so a fill can run from a list the user
  is not looking at; when it differs from what was saved the status line says
  `Unsaved mappings.` rather than letting that pass silently.
- **Save** stays enabled when the row list is empty but the page *has* saved
  mappings — deleting every row and saving is how a page's mappings get cleared.
  **Export** is disabled unless some stored site has a mapping; note that a site
  entry can exist holding only a toggle position (dragging the button writes one),
  so it counts mappings, not sites.
- Storage is one `chrome.storage.local` key, `pdftoformext.config`:
  `{version, sites: {"<origin><pathname>": {mappings: [{selector, key}], toggle: {x, y}}}}`.
  Query and hash are deliberately excluded from the site key. Export/Import move the
  whole file; import replaces the site groups it contains and leaves the rest.
- `chrome.storage` failures degrade to an in-memory config rather than throwing —
  the overlay must still work on a page where storage is unreachable.

## Constraints

- **Memory only.** No persistence of PDF *contents* anywhere, by any mechanism. This
  is the central privacy property of the extension — treat any change that persists
  extracted data as a bug. The mapping config is the one thing that is stored, and
  it holds only CSS selectors, PDF **key names** and the button's position. If you
  ever find yourself writing an entry's `value` to storage, that is the bug.
- **No network.** The PDF is never uploaded; pdf.js is vendored, not fetched from a
  CDN. The single `fetch` in the codebase reads the extension's own
  `overlay.css` over `chrome-extension://`.
- Overlay must not break host pages: shadow DOM or a heavily namespaced class
  prefix, and a `z-index` high enough to sit above typical page chrome.
- The manifest requests **`storage` and nothing else** — no `host_permissions`, no
  optional permissions. `storage` buys the per-URL mappings; `chrome.storage.local`
  rather than the page's `localStorage` precisely because the host page can read and
  clear the latter. Keeping the list at exactly one entry is what makes the privacy
  claim checkable at a glance, so do not add to it casually.
- Parsing runs in a real pdf.js worker where the host page's CSP allows one, and
  silently retries on the main thread ("fake worker") where it does not. Both
  paths are local; neither touches the network.

## Testing

`example/test-form.html` is the manual harness — open it directly (`file://` works
if the extension is allowed on file URLs). It carries a spread of input types
(text, email, tel, date, number, select, textarea, checkbox, radio), so mapping a
few of each exercises every branch of `applyValue` — the select and radio paths in
particular, which still do option matching.

The round trip is: load `example/test-form.pdf`, open Config, click fields on the
page, pick each one's key, **Fill page**. **Save** only decides whether those rows
come back on the next visit — filling works from the rows either way, and skipping
it should put `Unsaved mappings.` on the status line.

**The invariant is that nothing else moves.** Map two or three inputs, fill, and
confirm every unmapped input on the page is still exactly as it was. If anything
the mappings did not name gets a value, a guessing pass has crept back in.

Worth checking alongside it: with no PDF loaded, Config and Fill page are both
disabled and clicking a form field does nothing; after deleting every row, Fill
page goes back to disabled without needing a Save first.

`example/make-test-pdf.mjs` regenerates the fixture (`node example/make-test-pdf.mjs`).
Edit it rather than hand-patching the PDF.

Loading the extension: `chrome://extensions` → Developer mode → Load unpacked →
select this directory.
