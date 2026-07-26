# pdftoformtext

A Chrome extension (Manifest V3) that fills the form you are looking at from a PDF.

Click the button in the top-right corner of any page and pick a PDF: the extension
reads every AcroForm field and every table cell out of it. You then say, once per
page, which PDF value belongs in which input — click a field on the page and pick
its value out of the picker, which shows the PDF's tables as tables. **Fill page**
applies the mapping list as it stands; **Save** is what makes it come back on the
next visit.

It fills what you mapped and nothing else. No guessing at which input looks like
which field, so it never quietly writes a value somewhere you did not ask for.

When a value needs work before it lands — strip a currency sign, join a first and
last name, split a date, invent a key the PDF does not have — the **Script**
section at the top of Config is a JS editor over the extracted object. Press
**Run** and the mappings see the result. It always starts from the PDF as it was
read, so running twice is the same as running once.

**The PDF's contents never leave the tab.** They are held in a single variable in
the content script — never written to `chrome.storage`, `localStorage`, cookies or
IndexedDB, never uploaded — and are dropped when you navigate away. What is saved
is your mappings (selectors and PDF *key names*, never values) and your script.
The extension requests one permission, `storage`, and makes no network requests;
pdf.js and Ace are vendored in `vendor/`. Your script runs in a sandboxed frame
whose policy blocks network access outright, so it cannot send the PDF anywhere
either.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this directory

To try it on the bundled test page, also enable **Allow access to file URLs** on
the extension's details page.

## Try it

Open `example/test-form.html` and, in the panel:

1. **Load PDF…** → `example/test-form.pdf`
2. **Config** → click a field on the page, then click the row's key button and
   pick its value out of the picker. Repeat for as many fields as you like.
3. **Fill page** — with **Config** still open, if you like. Hit **Save** to keep
   the mapping for next time.

Only the fields you mapped are written; everything else is left alone, and the
form is never submitted. Saved mappings are remembered per page, so the next
visit is just *Load PDF…* → *Fill page*.

For the **Script** section, expand it and try:

```js
pdf['field.applicant_name'].value = pdf['field.applicant_name'].value.toUpperCase();
```

**Run**, then **Fill page**. The console reports what changed. Run it again and
the value is still upper-cased once, not twice — every run starts from the PDF as
pdf.js read it. **Save** keeps the script with the page's mappings; it is never
run on its own.

## How it works

| | |
|---|---|
| `src/content/bootstrap.js` | classic content script; loads the rest as ES modules |
| `src/content/overlay.js` | the overlay, and the only holder of the extracted data |
| `src/lib/pdf-extract.js` | PDF → one flat keyed object (`field.*`, `table.*`) |
| `src/lib/mappings.js` | per-URL `selector → key` config, and selector building |
| `src/lib/autofill.js` | that object → the page's inputs, by mapping only |
| `src/sandbox/runner.js` | the Script editor and evaluator, in a sandboxed frame |

Filling resolves each saved selector, coerces the PDF value to the input's kind
(dates, numbers, checkboxes, select options, radio groups) and writes it through
the native property setters so React- and Vue-controlled inputs register the
change.

The Script section is a separate frame because Manifest V3 forbids running a code
string in a content script. A sandboxed extension page is the supported way, and
it happens to be the right box for arbitrary code anyway: no extension APIs, no
storage, no reach into the page, no network. The overlay hands it the PDF over a
private channel and takes the edited object back.

There is no build step. See `CLAUDE.md` for the design rules and the reasoning
behind the extraction heuristics.
