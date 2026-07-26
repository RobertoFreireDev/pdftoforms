# pdftoformext

Browser extension (Chrome, Manifest V3) that loads a PDF, extracts every field and
table from it into a single keyed object held in memory, and uses that object to
fill the form on the page the user is currently viewing — through the per-URL
mappings the user configured, and only those.

## Status

Implemented and working end to end: overlay, extraction (AcroForm + geometric
tables), mapping-driven fill, per-URL field mapping, and the Config script
section. pdf.js 4.6.82 and Ace 1.44.0 are vendored. Update this file as pieces
change.

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
| Run (Script) | a PDF is loaded and the sandboxed editor frame has handed back its port |
| Save | a row has both selector and key, **or** there are saved mappings to clear, **or** the script differs from the saved one |
| Export | some stored site has ≥1 mapping or a script |

`refreshControls()` in `overlay.js` owns all of it and is called from every place
that can change those conditions; `refreshExportState()` is separate only because
it has to read storage.

## Layout

```
manifest.json               MV3 manifest
icons/
  icon-16.png               toolbar; drawn at its own scale, not downsampled
  icon-32.png               toolbar @2x; same compact geometry as 16
  icon-48.png               extensions page
  icon-128.png              store / install dialog
src/
  content/
    bootstrap.js            classic content script; dynamic-imports overlay.js
    overlay.js              injects the button, owns the in-memory extraction object
    overlay.css             overlay styles (draggable, high z-index)
  lib/
    pdf-extract.js          PDF -> keyed object (fields + tables)
    autofill.js             keyed object -> page inputs, by mapping only
    mappings.js             per-URL selector->key config; storage + selector building
  sandbox/
    runner.html             sandboxed extension page: the JS editor and evaluator
    runner.js               Ace setup, the MessagePort protocol, the example script
    runner.css              editor chrome; repeats overlay.css's palette
vendor/
  pdf.mjs                   pdf.js, vendored locally (MV3 CSP forbids remote scripts)
  pdf.worker.mjs
  LICENSE                   Apache 2.0, pdf.js
  ace/                      Ace 1.44.0, src-min-noconflict
    ace.js                  core; also carries the textmate theme's CSS module
    mode-javascript.js      loaded up front, so Ace never resolves a basePath
    theme-textmate.js       light
    theme-tomorrow_night.js dark
    LICENSE                 BSD-3-Clause, Ace
example/
  test-form.html            standalone page with fields, for manual testing
  test-form.pdf             fixture to fill from (AcroForm + two table shapes)
```

`bootstrap.js` exists because MV3 `content_scripts` cannot declare
`"type": "module"`. It is the only classic script *in the content world*;
everything it pulls in is a plain ES module, so every file under `src/` and
`vendor/` that gets imported must also be listed in `web_accessible_resources`.

`src/sandbox/` is the exception to all of that: it is a real extension page, not
content-script code, so it loads classic `<script src>` tags and its
sub-resources need no `web_accessible_resources` entry — only `runner.html`
does, because the content script frames it from a web page.

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

A headered data cell gets **both** table key shapes — two entries, one cell, with
identical `table`/`row`/`col`/`value` and only `key` differing. The positional one
is always emitted first. Anything reading the object back has to know that, which
is what `tablesOf` is for.

Rules:

- **Coverage is the requirement.** Every field and every table cell in the PDF must
  appear. Do not silently drop empty fields — emit them with an empty value.
- Keys must be **stable** for the same PDF and **unique**. On collision, suffix
  `__2`, `__3`, …. `entry.key` is written back by `put()`, so it is always the real
  map key — never reconstruct one from `table`/`row`/`col`.
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

`pdf-extract.js` also exports **`tablesOf(extraction)`**, the inverse of
`emitTables`: it regroups table cells into
`{index, page, cols, headers, rows}[]` so the Config picker can draw a table as a
table. It lives next to `emitTables` rather than in the UI because everything it
undoes is a choice made in `emitTables`, and the two invariants it leans on are
invisible from anywhere else:

- **Positional key first.** Dedupe keeps the first entry to claim a `row`/`col`
  slot, which is the positional one only because `emitTables` `put`s it before the
  header alias. Swap those two `put`s and the picker silently starts handing out
  alias keys.
- **`col` is sparse and unbounded.** `assignColumns` gives a cell that matches no
  band the slot `bands.length + used.size`, so indices can exceed the column count
  and can arrive out of visual order within a row. Iterate the `cols` array;
  `0..maxCol` renders phantom columns.

Which row was the header row is *not* recorded, and cannot be inferred safely — a
data cell in a column the header row did not cover also carries `header: ''`. The
picker sidesteps the question by rendering every row as a body row and taking its
column labels from `headers`.

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
- **The key is chosen by pointing at the value, never by typing an address.** A row
  carries its key in `data-key` and shows a button labelled with what that key
  resolves to (`T1 · Total · row 3 — 39.80`), with the raw key in the button's
  `title` — the key is still what gets saved and exported, so it stays inspectable,
  but it is not what anyone has to read. Clicking the button opens the **picker**,
  which offers `Fields` as a list and every table as an actual `<table>`: click the
  cell you can see, in the position you can see it in. Cells hand back the
  *positional* key, never the header alias, which only headered data cells even have.
  A saved key the loaded PDF does not contain (or when none is loaded) survives
  re-rendering as a warn-coloured label, so nothing is lost.
- The picker **takes over the Config area** rather than floating above it, because
  `.pfx-panel` is `overflow: hidden` and `.pfx-map-list` scrolls — a popup anchored
  to a row gets clipped by both. Taking over needs no positioning, no edge-flip and
  no outside-click handling; do not "improve" it into a popup.
- Picker details worth keeping: search is **global**, ignoring the active tab and
  listing each cell once, because people remember a value and not which block it
  landed in. `Clear` blanks a key without deleting the row — the dropdown's empty
  option was the only way to park a row, and losing it would have been a
  regression. Escape and Cancel are non-destructive: `chooseKey` is the one and
  only writer of `data-key`. Escape also `stopPropagation`s, or it escapes the
  shadow root into the host page's own handler. Selection is matched on the
  resolved entry's `table`/`row`/`col`, not on key strings, so an alias-keyed or
  `__2`-suffixed mapping still highlights.
- **Mappings are the only input to `Fill page`**, which calls `fillMapped` and
  touches nothing else on the page. It takes `currentRowMappings()` — the rows as
  they stand — not `savedMappings`, so a row can be tried before it is committed
  and the button stays live while Config is open. With no complete row, it is
  disabled. Rows outlive closing Config, so a fill can run from a list the user
  is not looking at; when it differs from what was saved the status line says
  `Unsaved mappings.` rather than letting that pass silently.
- **Save** stays enabled when the row list is empty but the page *has* saved
  mappings — deleting every row and saving is how a page's mappings get cleared.
  **Export** is disabled unless some stored site has a mapping or a script; note
  that a site entry can exist holding only a toggle position (dragging the button
  writes one), so it counts content, not sites.
- Storage is one `chrome.storage.local` key, `pdftoformext.config`:
  `{version, sites: {"<origin><pathname>": {mappings: [{selector, key}], toggle: {x, y}, script}}}`.
  Query and hash are deliberately excluded from the site key. Export/Import move the
  whole file; import replaces the site groups it contains and leaves the rest.
  `script` is additive, so `VERSION` stayed at 1 — an old config simply has none.
- `chrome.storage` failures degrade to an in-memory config rather than throwing —
  the overlay must still work on a page where storage is unreachable.

## The Script section

The first thing in Config, collapsed by default: an Ace editor for JS, a console,
and **Run**, which rewrites the extraction object. It exists because a mapping can
only *point at* a value — it cannot strip a `$`, join two fields, split a date or
mint a key the PDF does not contain.

**Run is idempotent by construction.** `extraction = clone(pristine)` happens
first and unconditionally, so a script always sees the PDF as pdf.js produced it,
never as its own last run left it. `pristine` is taken with `clone()` (JSON round
trip — every entry field is JSON-safe) in the Load PDF handler and cleared by
`forget()` alongside `extraction`; it is subject to every rule `extraction` is.
Since the restore happens before the code runs, a failed or hung script leaves the
PDF at its original values rather than half-edited.

### Why it is an iframe

`eval` and `new Function` are **blocked in an MV3 content script's isolated
world**. `content_security_policy.isolated_world` would lift that but is not in
shipping Chrome. A **sandboxed extension page** carries its own CSP and is the
supported way to run a code string, so the editor and the evaluator both live in
`src/sandbox/runner.html`, framed from `web_accessible_resources` (which is exempt
from the host page's `frame-src`). Do not try to move evaluation back into the
overlay — it cannot work there.

The sandbox earns its keep three more times over: Ace is a classic script and
loads on a real extension page with no ESM wrapper and no
`renderer.attachToShadowRoot()`; the frame has an opaque origin, so a user script
reaches no `chrome.*`, no storage and no host-page DOM; and `connect-src 'none'`
in the sandbox CSP makes the extension's no-network promise browser-enforced even
for code the user wrote themselves.

### The wire is a MessagePort, not the window

The frame sits in the **host page's** DOM, so its `window.parent` is a window the
page shares with the content script — anything posted there is readable by the
page, and *PDF contents travel this wire*. Only the frame's contentless
`pfx-ready` ping uses the window; the overlay answers by transferring a
`MessageChannel` port into the frame, and everything after that is private. Moving
any of it back onto `parent.postMessage` would leak the PDF to the page.

`event.source === jsFrame.contentWindow` is what authenticates the ping — the
browser sets `source`, so the page cannot forge it. The page *can* race a port of
its own into the frame, which only cuts itself off from the overlay's runs; it
never sees them.

| Direction | Message |
|---|---|
| frame → overlay | `{type:'pfx-ready'}` — over the window, carries nothing |
| overlay → frame | `{type:'pfx-port'}` with the transferred port |
| overlay → frame | `{type:'pfx-init', code}` — `null` means show `DEFAULT_SCRIPT` |
| frame → overlay | `{type:'pfx-change', code}`, debounced 250 ms |
| overlay → frame | `{type:'pfx-run', id, pdf}` |
| frame → overlay | `{type:'pfx-result', id, pdf, logs, error, ms}` |
| overlay → frame | `{type:'pfx-resize'}` |

### Details that are not obvious from the code

- The frame is created **lazily**, on first expand — ~1 MB of editor is not worth
  loading on every page. It keeps its document across collapse, the picker
  takeover and panel close, because `display: none` does not reload an iframe.
  Ace does mis-measure after any of those, which is what `remeasureEditor()` is
  for; it is called from `openScript`, `openConfig`, `openPanel` and `closePicker`.
- The section is the **first child of `.pfx-config-main`**, not a sibling, so the
  picker's takeover hides it too.
- `pfx-init` sets the editor through a `seeding` flag that suppresses the change
  notification. Without it, merely opening the section would report the boilerplate
  as an edit — lighting Save and the "saved script" dot for something nobody typed.
- Ace's syntax **worker is off** (`setUseWorker(false)`): it would need its own URL
  under an opaque origin, and syntax errors reach the console on Run anyway. That
  is why `worker-javascript.js` is not vendored. It has to be turned off **before**
  `setMode`, which starts the mode's worker itself — Ace spawns it from a `blob:`
  URL that the sandbox CSP's `child-src 'none'` blocks, so disabling it afterwards
  only stops a worker that already existed and already logged a violation.
- The sandbox CSP allows `img-src 'self' data:` because Ace's core CSS draws the
  gutter's fold arrows from inline `data:image/png` URLs; under `default-src 'none'`
  they are blocked and every editor line logs a violation. `data:` images fetch
  nothing, so this does not touch the no-network promise.
- `normalise()` re-files every returned entry so `entry.key` matches its map key,
  because `tablesOf`, the picker and `fillMapped` all assume it and a hand-built
  entry easily breaks it. It repairs and reports rather than rejecting.
- A run that does not answer within `RUN_TIMEOUT` (5 s) is ended by **replacing the
  iframe element**, not by re-`src`-ing it — a frame stuck mid-loop cannot be
  navigated, but it can be detached. The editor's text is restored from
  `scriptText`, which is why the debounced `pfx-change` mirror exists.
- The script is committed by the existing **Save** button, in the same `saveSite`
  call as the mappings, and is **never auto-run** on load. It is code the user
  wrote, not anything the PDF said, so storing it does not touch the privacy rule.

## Constraints

- **Memory only.** No persistence of PDF *contents* anywhere, by any mechanism. This
  is the central privacy property of the extension — treat any change that persists
  extracted data as a bug. The mapping config is the one thing that is stored, and
  it holds only CSS selectors, PDF **key names**, the button's position and the
  user's own script. `pristine` is under the same rule as `extraction`: a second
  in-memory copy, dropped by the same `forget()`. If you ever find yourself writing
  an entry's `value` to storage, that is the bug.
- **No network.** The PDF is never uploaded; pdf.js and Ace are vendored, not
  fetched from a CDN. The single `fetch` in the codebase reads the extension's own
  `overlay.css` over `chrome-extension://`. User scripts cannot break this: the
  sandbox CSP's `connect-src 'none'` blocks `fetch`, XHR, WebSocket and
  `sendBeacon` from the one place arbitrary code runs.
- Overlay must not break host pages: shadow DOM or a heavily namespaced class
  prefix, and a `z-index` high enough to sit above typical page chrome.
- The manifest requests **`storage` and nothing else** — no `host_permissions`, no
  optional permissions. `storage` buys the per-URL mappings; `chrome.storage.local`
  rather than the page's `localStorage` precisely because the host page can read and
  clear the latter. Keeping the list at exactly one entry is what makes the privacy
  claim checkable at a glance, so do not add to it casually. The `sandbox` and
  `content_security_policy` keys the script section added are not permissions and
  do not widen that list, and neither do `icons`/`action`.
- The toolbar button (`action`) is **icon only** — no popup and no `onClicked`
  handler, because there is no service worker and the whole UI is the in-page arrow
  button. It is there so the extension has a face in the toolbar. Giving it
  behaviour means adding a background script, which is a real change rather than a
  tweak to the manifest.
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
page, click each row's key button and pick a value out of the picker, **Fill page**.
**Save** only decides whether those rows come back on the next visit — filling works
from the rows either way, and skipping it should put `Unsaved mappings.` on the
status line.

**The invariant is that nothing else moves.** Map two or three inputs, fill, and
confirm every unmapped input on the page is still exactly as it was. If anything
the mappings did not name gets a value, a guessing pass has crept back in.

The fixture carries both table shapes on purpose, and the picker must render each
correctly: **Table 0** is a 2-column label/value block with no headers, so its
column strip reads `C0`/`C1`; **Table 1** is 4 columns with a real header row, so
the strip reads `Item`/`Quantity`/`Unit Price`/`Total`. Table 1 also has a title row
above its header row — both appear as ordinary numbered body rows, which is
deliberate (see `tablesOf`). Search for `39.80` and it should appear **once**, not
twice under two keys.

Worth checking alongside it: with no PDF loaded, Config and Fill page are both
disabled and clicking a form field does nothing; after deleting every row, Fill
page goes back to disabled without needing a Save first. In the picker, Escape and
Cancel must leave a key exactly as it was, `Clear` must blank it, and every way out
of the picker must close it cleanly — deleting the target row, clicking a page field
(which reveals and flashes the new row), loading a second PDF, closing Config,
collapsing the panel.

For the script section, the tests that actually catch regressions:

- **Idempotence.** `pdf['field.applicant_name'].value += '!'` and press Run five
  times. Exactly one `!` every time. This is the restore-from-`pristine` contract,
  and it is the first thing to break if the restore is moved or made conditional.
- **No-op.** Run the untouched boilerplate: `0 changed, 0 added, 0 removed`, and a
  subsequent Fill page behaves as if no script existed.
- **Table reshape.** Strip `$` from every cell of table 1 and Run; the picker must
  still draw Table 1 as 4 columns under `Item/Quantity/Unit Price/Total`, and
  `39.80` must still be found once.
- **Failure leaves nothing behind.** `pdf.nope.value = 1;` → the error is in the
  console, the status line says the PDF is unchanged, and the picker still shows
  original values. `while (true) {}` → stopped after 5 s with the panel and the
  host page both still responsive, and the editor still holding the code.
- **No network.** `fetch('https://example.com')` must be refused by the sandbox CSP
  with nothing on the wire.
- **Nothing typed, nothing saved.** Open the section and press Save without editing:
  the boilerplate must not be stored, and the toggle's dot must not appear. Then
  edit, Save, reload — the script comes back, collapsed, and has *not* run.
- **Frame survives.** Expanded, open and cancel the picker, collapse and reopen
  Config, collapse and reopen the panel: the editor comes back correctly sized
  every time rather than as a 0-height strip.

Loading the extension: `chrome://extensions` → Developer mode → Load unpacked →
select this directory.
