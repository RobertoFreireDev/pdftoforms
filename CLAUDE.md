# pdftoformext

Browser extension (Chrome, Manifest V3) that loads a PDF, extracts every field and
table from it into a single keyed object held in memory, and uses that object to
autofill the form on the page the user is currently viewing.

## Status

Implemented and working end to end: overlay, extraction (AcroForm + geometric
tables), and autofill. pdf.js 4.6.82 is vendored. Update this file as pieces
change.

## Core flow

1. A content script injects a floating overlay button in the **top-right corner of
   the current page**.
2. Clicking it opens a file picker (`<input type="file" accept="application/pdf">`).
3. The chosen PDF is parsed **client-side** with pdf.js. Extraction produces one
   flat object: every AcroForm field and every table cell in the document gets a key.
4. That object lives **in memory only** (a module-level variable in the content
   script). It is never written to `chrome.storage`, `localStorage`, cookies, a
   server, or anywhere else, and it is discarded on page unload.
5. The object is then matched against the inputs on the current page and used to
   autofill them.

## Layout

```
manifest.json               MV3 manifest
src/
  content/
    bootstrap.js            classic content script; dynamic-imports overlay.js
    overlay.js              injects the button, owns the in-memory extraction object
    overlay.css             overlay styles (top-right, high z-index)
  lib/
    pdf-extract.js          PDF -> keyed object (fields + tables)
    autofill.js             keyed object -> page inputs
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

## Autofill matching

`autofill.js` walks `input`, `select`, and `textarea` on the page and scores each
against the extraction object using, in order of confidence:

1. exact `name` / `id` match against the key or the raw PDF field name
2. `<label for>` text, `aria-label`, or `placeholder` vs. the entry's `label`
3. normalized fuzzy match (lowercase, strip non-alphanumerics)

Only fill above a confidence threshold; leave ambiguous inputs alone rather than
guessing. After setting `.value`, dispatch `input` and `change` events with
`bubbles: true` so React/Vue/Angular-controlled inputs actually register the value.
Never submit the form.

Two details worth knowing before touching the scoring:

- "Ambiguous" means the runner-up scores within `AMBIGUITY_MARGIN` of the winner
  and points at a **different** value. A headed table cell is emitted under two
  keys, so candidates are compared by cell identity, not by key — otherwise every
  such cell would look like a tie with itself and never fill.
- Values are written through the prototype's `value`/`checked` setter, not
  `el.value = …`. React patches the instance property to track changes; assigning
  directly leaves the framework's state stale even though the DOM looks right.

## Constraints

- **Memory only.** No persistence of PDF contents anywhere, by any mechanism. This
  is the central privacy property of the extension — treat any change that persists
  extracted data as a bug.
- **No network.** The PDF is never uploaded; pdf.js is vendored, not fetched from a
  CDN. The single `fetch` in the codebase reads the extension's own
  `overlay.css` over `chrome-extension://`.
- Overlay must not break host pages: shadow DOM or a heavily namespaced class
  prefix, and a `z-index` high enough to sit above typical page chrome.
- The manifest requests **no permissions** — no `storage`, no `host_permissions`.
  A content-script match is all this needs, and keeping the permission list empty
  is what makes the privacy claim checkable at a glance.
- Parsing runs in a real pdf.js worker where the host page's CSP allows one, and
  silently retries on the main thread ("fake worker") where it does not. Both
  paths are local; neither touches the network.

## Testing

`example/test-form.html` is the manual harness — open it directly (`file://` works
if the extension is allowed on file URLs) and fill it from `example/test-form.pdf`.
It carries a spread of input types (text, email, tel, date, number, select,
textarea, checkbox, radio) with names deliberately *near* but not identical to the
PDF's field names, so the fuzzy matcher is actually exercised.

Two inputs on that page — `#total` and `#favouriteColour` — are expected to stay
**empty**: the first is genuinely ambiguous against a table column of three
totals, the second matches nothing. If a change starts filling either, the
confidence guards have regressed.

`example/make-test-pdf.mjs` regenerates the fixture (`node example/make-test-pdf.mjs`).
Edit it rather than hand-patching the PDF.

Loading the extension: `chrome://extensions` → Developer mode → Load unpacked →
select this directory.
