# pdftoformext

Browser extension (Chrome, Manifest V3) that loads a PDF, extracts every field and
table from it into a single keyed object held in memory, and uses that object to
autofill the form on the page the user is currently viewing.

## Status

Greenfield. Nothing is implemented yet — the layout below is the target, not a
description of existing code. Update this file as pieces land.

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
    overlay.js              injects the button, owns the in-memory extraction object
    overlay.css             overlay styles (top-right, high z-index)
  lib/
    pdf-extract.js          PDF -> keyed object (fields + tables)
    autofill.js             keyed object -> page inputs
vendor/
  pdf.mjs                   pdf.js, vendored locally (MV3 CSP forbids remote scripts)
  pdf.worker.mjs
example/
  test-form.html            standalone page with fields, for manual testing
```

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

## Constraints

- **Memory only.** No persistence of PDF contents anywhere, by any mechanism. This
  is the central privacy property of the extension — treat any change that persists
  extracted data as a bug.
- **No network.** The PDF is never uploaded; pdf.js is vendored, not fetched from a
  CDN.
- Overlay must not break host pages: shadow DOM or a heavily namespaced class
  prefix, and a `z-index` high enough to sit above typical page chrome.

## Testing

`example/test-form.html` is the manual harness — open it directly (`file://` works
if the extension is allowed on file URLs) and run the full flow against it. It
should carry a spread of input types (text, email, date, number, select, textarea,
checkbox) with names deliberately *near* but not identical to typical PDF field
names, so the fuzzy matcher is actually exercised.

Loading the extension: `chrome://extensions` → Developer mode → Load unpacked →
select this directory.
