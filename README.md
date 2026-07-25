# pdftoformtext

A Chrome extension (Manifest V3) that fills the form you are looking at from a PDF.

Click the button in the top-right corner of any page and pick a PDF: the extension
reads every AcroForm field and every table cell out of it. You then say, once per
page, which PDF value belongs in which input — click a field on the page, pick its
value from the dropdown, save. From then on **Fill page** fills that page.

It fills what you mapped and nothing else. No guessing at which input looks like
which field, so it never quietly writes a value somewhere you did not ask for.

**The PDF's contents never leave the tab.** They are held in a single variable in
the content script — never written to `chrome.storage`, `localStorage`, cookies or
IndexedDB, never uploaded — and are dropped when you navigate away. The mappings
are saved (selectors and PDF *key names* only, never values). The extension
requests one permission, `storage`, and makes no network requests; pdf.js is
vendored in `vendor/`.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this directory

To try it on the bundled test page, also enable **Allow access to file URLs** on
the extension's details page.

## Try it

Open `example/test-form.html` and, in the panel:

1. **Load PDF…** → `example/test-form.pdf`
2. **Config** → click a field on the page, then pick its value from the dropdown.
   Repeat for as many fields as you like.
3. **Save**, then **Fill page**.

Only the fields you mapped are written; everything else is left alone, and the
form is never submitted. Mappings are remembered per page, so the next visit is
just *Load PDF…* → *Fill page*.

## How it works

| | |
|---|---|
| `src/content/bootstrap.js` | classic content script; loads the rest as ES modules |
| `src/content/overlay.js` | the overlay, and the only holder of the extracted data |
| `src/lib/pdf-extract.js` | PDF → one flat keyed object (`field.*`, `table.*`) |
| `src/lib/mappings.js` | per-URL `selector → key` config, and selector building |
| `src/lib/autofill.js` | that object → the page's inputs, by mapping only |

Filling resolves each saved selector, coerces the PDF value to the input's kind
(dates, numbers, checkboxes, select options, radio groups) and writes it through
the native property setters so React- and Vue-controlled inputs register the
change.

There is no build step. See `CLAUDE.md` for the design rules and the reasoning
behind the extraction heuristics.
