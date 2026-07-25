/**
 * Floating overlay, top-right of whatever page the user is on.
 *
 * This module owns the extraction object. It is a plain module-level variable:
 * never written to chrome.storage, localStorage, cookies, IndexedDB or the
 * network, and dropped when the page goes away. Treat any change to that as a
 * bug — it is the whole privacy story of this extension.
 */

import { extractPdf } from '../lib/pdf-extract.js';
import { autofill } from '../lib/autofill.js';

/** The one and only copy of the current PDF's contents. In memory, nowhere else. */
let extraction = null;

const HOST_ID = 'pdftoformext-overlay-host';

function forget() {
  extraction = null;
}

// Belt and braces: drop the data on navigation even though the whole isolated
// world is torn down anyway.
addEventListener('pagehide', forget);
addEventListener('beforeunload', forget);

/* ------------------------------------------------------------------ *
 * UI
 * ------------------------------------------------------------------ */

async function buildOverlay() {
  if (document.getElementById(HOST_ID)) return null;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // The host itself carries no layout beyond position, so it cannot disturb the
  // page; everything else is sealed inside the shadow root.
  host.style.cssText = 'all: initial; position: fixed; top: 0; right: 0; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = await loadStyles();
  shadow.append(style);

  shadow.append(render());
  (document.body ?? document.documentElement).append(host);
  return shadow;
}

async function loadStyles() {
  try {
    const res = await fetch(chrome.runtime.getURL('src/content/overlay.css'));
    return await res.text();
  } catch {
    return ':host { font-family: sans-serif; }';
  }
}

function render() {
  const root = document.createElement('div');
  root.className = 'pfx-root';
  root.innerHTML = `
    <button class="pfx-toggle" type="button" title="Fill this form from a PDF">
      <span class="pfx-toggle-icon" aria-hidden="true">PDF</span>
      <span class="pfx-toggle-text">Fill from PDF</span>
    </button>
    <section class="pfx-panel" hidden>
      <header class="pfx-panel-head">
        <span class="pfx-title">Fill from PDF</span>
        <button class="pfx-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="pfx-body">
        <p class="pfx-status">No PDF loaded.</p>
        <div class="pfx-actions">
          <button class="pfx-choose" type="button">Choose PDF…</button>
          <button class="pfx-fill" type="button" disabled>Fill page</button>
          <button class="pfx-clear" type="button" disabled>Clear</button>
        </div>
        <details class="pfx-details" hidden>
          <summary class="pfx-summary">Details</summary>
          <div class="pfx-report"></div>
        </details>
        <p class="pfx-note">Contents stay in this tab's memory only.</p>
      </div>
      <input class="pfx-file" type="file" accept="application/pdf,.pdf" hidden>
    </section>
  `;
  return root;
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function wire(shadow) {
  const $ = (selector) => shadow.querySelector(selector);

  const toggle = $('.pfx-toggle');
  const panel = $('.pfx-panel');
  const status = $('.pfx-status');
  const fileInput = $('.pfx-file');
  const fillButton = $('.pfx-fill');
  const clearButton = $('.pfx-clear');
  const details = $('.pfx-details');
  const report = $('.pfx-report');

  const setStatus = (text, tone = '') => {
    status.textContent = text;
    status.dataset.tone = tone;
  };

  const setLoaded = (loaded) => {
    fillButton.disabled = !loaded;
    clearButton.disabled = !loaded;
    toggle.classList.toggle('pfx-loaded', loaded);
  };

  const openPanel = (open) => {
    panel.hidden = !open;
    toggle.classList.toggle('pfx-open', open);
  };

  toggle.addEventListener('click', () => {
    const opening = panel.hidden;
    openPanel(opening);
    // First click goes straight to the picker; there is nothing else to see yet.
    if (opening && !extraction) fileInput.click();
  });

  $('.pfx-close').addEventListener('click', () => openPanel(false));
  $('.pfx-choose').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;

    setStatus(`Reading ${file.name}…`);
    details.hidden = true;
    setLoaded(false);

    try {
      const buffer = await file.arrayBuffer();
      extraction = await extractPdf(buffer);
      const counts = summarize(extraction);
      setStatus(`${counts.total} values from ${file.name} (${counts.fields} fields, ${counts.cells} table cells).`, 'ok');
      setLoaded(true);
      runFill();
    } catch (err) {
      forget();
      setLoaded(false);
      setStatus(`Could not read that PDF: ${err?.message ?? err}`, 'error');
      console.error('[pdftoformext] extraction failed:', err);
    }
  });

  function runFill() {
    if (!extraction) return;
    const result = autofill(extraction, { root: document });
    const counts = summarize(extraction);

    setStatus(
      result.filled.length
        ? `Filled ${result.filled.length} of ${result.targets} inputs from ${counts.total} PDF values.`
        : `No confident matches among ${result.targets} inputs — nothing was changed.`,
      result.filled.length ? 'ok' : 'warn',
    );

    report.replaceChildren(renderReport(result));
    details.hidden = false;
  }

  fillButton.addEventListener('click', runFill);

  clearButton.addEventListener('click', () => {
    forget();
    setLoaded(false);
    details.hidden = true;
    report.replaceChildren();
    setStatus('Cleared. Nothing from the PDF is left in memory.');
  });
}

function summarize(entries) {
  const values = Object.values(entries);
  return {
    total: values.length,
    fields: values.filter((entry) => entry.source === 'acroform').length,
    cells: values.filter((entry) => entry.source === 'table').length,
  };
}

function renderReport(result) {
  const list = document.createElement('dl');
  list.className = 'pfx-list';

  for (const item of result.filled) {
    const term = document.createElement('dt');
    term.textContent = item.target;
    const def = document.createElement('dd');
    def.textContent = `${truncate(String(item.value))}  ·  ${item.key}`;
    list.append(term, def);
  }

  const unmatched = result.skipped.filter((item) => item.reason !== 'no match').length;
  if (unmatched) {
    const note = document.createElement('dt');
    note.className = 'pfx-list-note';
    note.textContent = `${unmatched} input(s) left alone (ambiguous or already filled).`;
    list.append(note);
  }

  if (!list.children.length) list.textContent = 'Nothing matched confidently.';
  return list;
}

function truncate(text, max = 48) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

buildOverlay()
  .then((shadow) => shadow && wire(shadow))
  .catch((err) => console.error('[pdftoformext] overlay failed to mount:', err));
