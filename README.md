# pdftoformtext

A Chrome extension (Manifest V3) that fills the form you are looking at from a PDF.

Click the button in the top-right corner of any page, pick a PDF, and the
extension reads every AcroForm field and every table cell out of it and matches
them against the inputs on the page.

**The PDF's contents never leave the tab.** They are held in a single variable in
the content script — never written to `chrome.storage`, `localStorage`, cookies or
IndexedDB, never uploaded — and are dropped when you navigate away or hit
*Clear*. The extension requests no permissions and makes no network requests;
pdf.js is vendored in `vendor/`.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this directory

To try it on the bundled test page, also enable **Allow access to file URLs** on
the extension's details page.

## Try it

Open `example/test-form.html`, click **Fill from PDF**, and choose
`example/test-form.pdf`.

Thirteen of the fifteen inputs fill. Two are meant to stay empty: `Total` is
ambiguous against a table column holding three different totals, and
`Favourite colour` matches nothing in the PDF. The extension declines rather than
guessing, and it never submits the form.

## How it works

| | |
|---|---|
| `src/content/bootstrap.js` | classic content script; loads the rest as ES modules |
| `src/content/overlay.js` | the overlay, and the only holder of the extracted data |
| `src/lib/pdf-extract.js` | PDF → one flat keyed object (`field.*`, `table.*`) |
| `src/lib/autofill.js` | that object → the page's inputs, scored and thresholded |

Matching runs in three tiers — exact `name`/`id`, exact label text, then a
normalized fuzzy score — and writes values through the native property setters so
React- and Vue-controlled inputs register the change.

There is no build step. See `CLAUDE.md` for the design rules and the reasoning
behind the extraction heuristics.
